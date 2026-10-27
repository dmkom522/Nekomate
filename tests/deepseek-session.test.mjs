import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { LearningSessions } from '../src/core/learning-session.mjs';
import { normalizeConfig } from '../src/core/provider.mjs';

const image = 'data:image/jpeg;base64,/9j/2Q==';
const searchCall = { id: 'course-search-1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '公开矩阵课程' }) } };
const response = (message, finish_reason = 'stop') => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
const marker = 'SEARCH_CONTEXT_MUST_SURVIVE';
const toolReasoning = 'opaque-tool-reasoning';
const finalReasoning = 'opaque-final-reasoning';

async function serverFixture(work) {
  const requests = [], handlerErrors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const item = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }; requests.push(item);
      res.setHeader('Content-Type', 'application/json');
      if (item.path.endsWith('/tools/search')) {
        assert.deepEqual(item.body, { query: '公开矩阵课程', count: 5, need_content: true });
        res.end(JSON.stringify({ results: [{ title: '线性代数公开课', url: 'https://course.example/lecture', content: marker }] })); return;
      }
      assert.ok(item.path.endsWith('/chat/completions'));
      const tools = item.body.messages.filter(message => message.role === 'tool');
      if (item.body.tools) {
        if (!tools.length) {
          res.end(JSON.stringify(response({ content: null, reasoning_content: toolReasoning, tool_calls: [searchCall] }, 'tool_calls'))); return;
        }
        assert.equal(tools.length, 1);
        assert.match(tools[0].content, new RegExp(marker));
        assert.equal(item.body.messages.find(message => message.tool_calls).reasoning_content, toolReasoning);
        res.end(JSON.stringify(response({ content: '课程背景：矩阵行变换与消元。', reasoning_content: finalReasoning }))); return;
      }
      assert.equal(Object.hasOwn(item.body, 'tool_choice'), false, 'ordinary questions do not enable another web loop');
      const recalled = tools.some(message => message.content.includes(marker));
      res.end(JSON.stringify(response({ content: recalled ? `已沿用课程背景：${marker}` : 'NO_COURSE_MEMORY' })));
    } catch (error) {
      handlerErrors.push(error); if (!res.headersSent) res.writeHead(500); res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}/v1`, requests); }
  finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(handlerErrors, [], 'synthetic HTTP service assertions');
  }
}

test('DeepSeek canonical API session preserves tool calls, results and reasoning through follow-up and restart without repeated search', async () => {
  const temporaryRoot = path.resolve('.local'); await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, 'deepseek-session-'));
  const managers = [];
  const makeManager = () => { const manager = new LearningSessions({ root }); managers.push(manager); return manager; };
  const stored = async () => JSON.parse(await readFile(path.join(root, 'lecture', 'binding.json'), 'utf8'));
  try {
    await serverFixture(async (baseUrl, requests) => {
      const config = normalizeConfig({ mode: 'api', vision: { provider: 'deepseek', protocol: 'openai', baseUrl, model: 'deepseek-flash', apiKey: 'synthetic-deepseek-key' }, fastMode: false });
      const manager = makeManager(); await manager.create('lecture', config);
      const course = { eventId: 'course-background', frames: [{ eventId: 'course-picture', time: 0, image }], source: '矩阵课程' };
      const discovered = await manager.run('lecture', 'course-context', course, config);
      assert.equal(discovered.text, '课程背景：矩阵行变换与消元。');
      const savedCourse = (await stored()).messages;
      assert.deepEqual(savedCourse.map(message => message.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
      assert.deepEqual(savedCourse[2].tool_calls, [searchCall]);
      assert.equal(savedCourse[2].reasoning_content, toolReasoning);
      assert.equal(savedCourse[3].tool_call_id, searchCall.id);
      assert.match(savedCourse[3].content, new RegExp(marker));
      assert.equal(savedCourse[4].reasoning_content, finalReasoning);
      assert.equal(savedCourse[4].content, discovered.text);
      assert.equal(requests.filter(request => request.path.endsWith('/tools/search')).length, 1);

      const answer = await manager.run('lecture', 'answer', { eventId: 'follow-up', question: '解释一下行变换的背景' }, config);
      assert.match(answer.answer, new RegExp(marker));
      const firstFollowup = requests.filter(request => request.path.endsWith('/chat/completions')).at(-1).body;
      assert.deepEqual(firstFollowup.messages.slice(0, -1), savedCourse);
      assert.equal(firstFollowup.messages.filter(message => message.tool_calls).length, 1);
      assert.equal(firstFollowup.messages.filter(message => message.role === 'tool').length, 1);
      assert.equal(Object.hasOwn(firstFollowup, 'tools'), false);
      assert.equal(requests.filter(request => request.path.endsWith('/tools/search')).length, 1);
      const savedAfterQuestion = (await stored()).messages;

      manager.dispose(); const restarted = makeManager(); await restarted.resume('lecture', config);
      const remembered = await restarted.run('lecture', 'answer', { eventId: 'after-restart', question: '再结合刚才的背景解释' }, config);
      assert.match(remembered.answer, new RegExp(marker));
      const afterRestart = requests.filter(request => request.path.endsWith('/chat/completions')).at(-1).body;
      assert.deepEqual(afterRestart.messages.slice(0, -1), savedAfterQuestion);
      assert.deepEqual(afterRestart.messages.find(message => message.tool_calls).tool_calls, [searchCall]);
      assert.equal(afterRestart.messages.find(message => message.tool_calls).reasoning_content, toolReasoning);
      assert.equal(afterRestart.messages.filter(message => message.role === 'tool').length, 1);
      assert.equal(afterRestart.messages.filter(message => Array.isArray(message.content)).flatMap(message => message.content).filter(part => part.type === 'image_url').length, 1);
      assert.equal(Object.hasOwn(afterRestart, 'tools'), false);
      const beforeCached = requests.length;
      assert.equal((await restarted.run('lecture', 'course-context', course, config)).text, discovered.text);
      assert.equal(requests.length, beforeCached, 'cached same event does not rerun search or the completion');
      assert.equal(requests.filter(request => request.path.endsWith('/tools/search')).length, 1);
      assert.ok(requests.every(request => request.auth === 'Bearer synthetic-deepseek-key'));

      await restarted.create('separate-lecture', config);
      const isolated = await restarted.run('separate-lecture', 'answer', { eventId: 'separate-question', question: '有刚才课程的背景吗' }, config);
      assert.equal(isolated.answer, 'NO_COURSE_MEMORY');
    });
  } finally {
    managers.forEach(manager => manager.dispose());
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith('deepseek-session-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
