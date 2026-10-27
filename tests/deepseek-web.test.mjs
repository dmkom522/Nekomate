import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { identifyCourse, normalizeConfig } from '../src/core/provider.mjs';
import { readChatStream } from '../src/core/streaming.mjs';

const image = 'data:image/jpeg;base64,/9j/2Q==';
const courseInput = { frames: [{ image, time: 0 }, { image, time: 15 }, { image, time: 30 }], source: '课程窗口' };
const call = (name, args, id = 'web1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (message, finish_reason = 'stop') => ({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
async function fixture(handler, work) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const item = { path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) }; requests.push(item);
      res.setHeader('Content-Type', 'application/json');
      await handler(item, res, requests);
    } catch { if (!res.headersSent) res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await work(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const configFor = baseUrl => normalizeConfig({ mode: 'api', vision: { provider: 'deepseek', baseUrl, model: 'deepseek-flash', apiKey: 'only-deepseek-test-key' } });
const sse = value => `data: ${JSON.stringify(value)}\n\n`;

for (const suffix of ['', '/v1']) test(`DeepSeek direct ${suffix || 'root'} carries images through search, fetch and final answer with one key`, async () => {
  await fixture((item, res) => {
    if (item.path.endsWith('/tools/search')) {
      assert.deepEqual(item.body, { query: '公开矩阵课程', count: 5, need_content: true });
      res.end(JSON.stringify({ results: [{ title: '公开线性代数课程', url: 'https://course.example/lecture', summary: 'WEB_MARKER_2026' }] })); return;
    }
    if (item.path.endsWith('/tools/fetch')) {
      assert.equal(item.body.url, 'https://course.example/lecture');
      res.end(JSON.stringify({ title: '课程', content: 'FETCH_MARKER_2026：矩阵第二行减去第一行两倍。' })); return;
    }
    assert.ok(item.body.tools.some(t => t.function.name === 'web_search'));
    assert.ok(item.body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url' && p.image_url.url === image)));
    const outputs = item.body.messages.filter(m => m.role === 'tool');
    if (!outputs.length) res.end(JSON.stringify(reply({ reasoning_content: 'opaque-reasoning-preserved', content: null, tool_calls: [call('web_search', { query: '公开矩阵课程' })] }, 'tool_calls')));
    else if (outputs.length === 1) {
      assert.match(outputs[0].content, /WEB_MARKER_2026/);
      assert.equal(item.body.messages.find(m => m.tool_calls).reasoning_content, 'opaque-reasoning-preserved');
      res.end(JSON.stringify(reply({ content: null, tool_calls: [call('web_fetch', { url: 'https://course.example/lecture' }, 'web2')] }, 'tool_calls')));
    } else {
      assert.match(outputs[1].content, /FETCH_MARKER_2026/);
      res.end(JSON.stringify(reply({ content: '查到的课程内容：FETCH_MARKER_2026，解释第二行消元。' })));
    }
  }, async (root, requests) => {
    const config = configFor(root + suffix);
    const result = await identifyCourse(config, courseInput);
    assert.match(result.text, /FETCH_MARKER_2026/);
    assert.equal(requests.filter(r => r.path === '/v1/tools/search').length, 1);
    assert.equal(requests.filter(r => r.path === '/v1/tools/fetch').length, 1);
    assert.ok(requests.every(r => r.auth === 'Bearer only-deepseek-test-key'));
    await identifyCourse(config, courseInput);
    assert.equal(requests.filter(r => r.path.endsWith('/tools/search')).length, 1, 'same-service repeated query uses cache');
    assert.equal(requests.filter(r => r.path.endsWith('/tools/fetch')).length, 1);
    const changed = normalizeConfig({ vision: { apiKey: 'another-deepseek-key' } }, config);
    await identifyCourse(changed, courseInput);
    assert.equal(requests.filter(r => r.path.endsWith('/tools/search')).length, 2, 'cache is isolated by key');
    assert.ok(requests.every(r => !r.path.includes('messages') && !JSON.stringify(r).includes('claude')));
  });
});

test('DeepSeek streamed tool arguments and reasoning are preserved, final answer streams before completion', async () => {
  let finished = false, release;
  await fixture(async (item, res) => {
    if (item.path.endsWith('/tools/search')) { res.end(JSON.stringify({ results: [{ title: '标题', url: 'https://course.example', content: '课程正文' }] })); return; }
    const outputs = item.body.messages.filter(m => m.role === 'tool');
    res.setHeader('Content-Type', 'text/event-stream');
    if (!outputs.length) {
      res.write(sse({ choices: [{ delta: { reasoning_content: 'private-reasoning', tool_calls: [{ index: 0, id: 's1', type: 'function', function: { name: 'web_search', arguments: '{"query":"公开' } }] } }] }));
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '课程"}' } }] }, finish_reason: 'tool_calls' }] }));
      res.end('data: [DONE]\n\n'); return;
    }
    assert.equal(item.body.messages.find(m => m.tool_calls).reasoning_content, 'private-reasoning');
    res.write(sse({ choices: [{ delta: { content: '矩阵' } }] }));
    await new Promise(resolve => { release = resolve; });
    res.write(sse({ choices: [{ delta: { content: '解释' }, finish_reason: 'stop' }] }));
    finished = true; res.end('data: [DONE]\n\n');
  }, async root => {
    const chunks = [];
    const result = await identifyCourse(configFor(root), courseInput, undefined, undefined, delta => {
      chunks.push(delta); assert.equal(delta.includes('private-reasoning'), false);
      if (chunks.length === 1) { assert.equal(finished, false); release(); }
    });
    assert.deepEqual(chunks, ['矩阵', '解释']); assert.equal(result.text, '矩阵解释');
  });
});

test('DeepSeek search errors are returned as unavailable evidence without leaking server secrets or invoking another provider', async () => {
  await fixture((item, res) => {
    if (item.path.endsWith('/tools/search')) { res.writeHead(403); res.end('secret echoed must not leak'); return; }
    const output = item.body.messages.find(m => m.role === 'tool');
    if (!output) res.end(JSON.stringify(reply({ tool_calls: [call('web_search', { query: '课程主题' })] }, 'tool_calls')));
    else {
      assert.equal(item.body.tool_choice, 'none');
      assert.match(output.content, /403/); assert.doesNotMatch(output.content, /secret echoed/);
      res.end(JSON.stringify(reply({ content: '未取得外部资料，结合当前课程内容解释。' })));
    }
  }, async root => {
    const result = await identifyCourse(configFor(root), courseInput);
    assert.match(result.text, /未取得外部资料/); assert.equal(result.usage.total_tokens, 24);
  });
});

for (const tool of [call('read_file', { path: 'private.txt' }), call('web_fetch', { url: 'http://127.0.0.1/private' }), call('web_search', { query: 'x'.repeat(129) })]) {
  test(`DeepSeek rejects invalid ${tool.function.name} arguments before any web request`, async () => {
    await fixture((item, res) => {
      assert.ok(item.path.endsWith('/chat/completions'));
      const output = item.body.messages.find(m => m.role === 'tool');
      res.end(JSON.stringify(output ? reply({ content: '仅用已有资料回答。' }) : reply({ tool_calls: [tool] }, 'tool_calls')));
    }, async (root, requests) => {
      assert.equal((await identifyCourse(configFor(root), courseInput)).text, '仅用已有资料回答。');
      assert.equal(requests.length, 2); assert.ok(requests.every(r => r.path === '/chat/completions'));
    });
  });
}

test('DeepSeek limits web execution and pairs every requested tool ID before finishing', async () => {
  await fixture((item, res) => {
    if (item.path.endsWith('/tools/search')) { res.end('{"results":[]}'); return; }
    const outputs = item.body.messages.filter(m => m.role === 'tool');
    if (!outputs.length) res.end(JSON.stringify(reply({ tool_calls: Array.from({ length: 8 }, (_, i) => call('web_search', { query: `课程${i}` }, `tool${i}`)) }, 'tool_calls')));
    else { assert.equal(outputs.length, 8); assert.equal(item.body.tool_choice, 'none'); res.end(JSON.stringify(reply({ content: '没有查到课程。' }))); }
  }, async (root, requests) => {
    await identifyCourse(configFor(root), courseInput);
    assert.equal(requests.filter(r => r.path.endsWith('/tools/search')).length, 4);
  });
});

test('truncated DeepSeek tool streams are not accepted as complete tool calls', async () => {
  await assert.rejects(readChatStream(new Response(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'web_search', arguments: '{}' } }] } }] })), 'openai', () => {}, { allowToolCalls: true }), /未完成/);
});

test('cancelling DeepSeek while a search body is pending stops the tool loop', async () => {
  let entered, closed = false;
  const ready = new Promise(resolve => { entered = resolve; });
  await fixture((item, res) => {
    if (item.path.endsWith('/tools/search')) {
      res.on('close', () => { closed = true; });
      res.write('{"results":['); entered(); return;
    }
    res.end(JSON.stringify(reply({ tool_calls: [call('web_search', { query: '取消时的课程' })] }, 'tool_calls')));
  }, async (root, requests) => {
    const controller = new AbortController();
    const pending = identifyCourse(configFor(root), courseInput, controller.signal);
    await ready; controller.abort();
    await assert.rejects(pending, /取消/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requests.filter(r => r.path.endsWith('/chat/completions')).length, 1);
    assert.equal(closed, true);
  });
});
