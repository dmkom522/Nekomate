import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

test('DeepSeek desktop sends search and its result through the current API session, then answers with the retrieved content', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'deepseek-flash', input_modalities: ['image', 'text'] }] })); return; }
    if (req.url === '/v1/tools/search') {
      expect(body.query).toBe('线性代数公开课程');
      res.end(JSON.stringify({ results: [{ title: '公开课程', url: 'https://course.example', content: 'DESKTOP_SEARCH_MARKER：矩阵第二行减去第一行两倍。' }] })); return;
    }
    expect(req.url).toBe('/chat/completions');
    const tool = body.messages.find(m => m.role === 'tool');
    const hasImage = body.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
    const message = !body.tools ? { content: `复用课程背景：${JSON.stringify(body.messages).includes('DESKTOP_SEARCH_MARKER') ? 'DESKTOP_SEARCH_MARKER' : '没有背景'}` } : tool ? { content: `${hasImage ? '画面笔记' : '答疑'}：${JSON.parse(tool.content).results[0].content}` }
      : { content: null, reasoning_content: 'private tool reasoning', tool_calls: [{ id: 'search1', type: 'function', function: { name: 'web_search', arguments: '{"query":"线性代数公开课程"}' } }] };
    const reason = !body.tools || tool ? 'stop' : 'tool_calls';
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const delta = !body.tools || tool ? { content: message.content } : { reasoning_content: message.reasoning_content, tool_calls: [{ index: 0, ...message.tool_calls[0] }] };
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
    } else res.end(JSON.stringify({ choices: [{ message, finish_reason: reason }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(path.resolve('.local/deepseek-web-desktop-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile, AI_MODE: 'api', VISION_PROVIDER: 'deepseek', VISION_PROTOCOL: 'openai', VISION_BASE_URL: baseUrl, VISION_MODEL: 'deepseek-flash', VISION_API_KEY: 'desktop-deepseek-fixture-key' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
    await expect.poll(() => app.windows().some(page => page.url().endsWith('/index.html'))).toBe(true);
    const page = app.windows().find(page => page.url().endsWith('/index.html'));
    await expect(page.locator('#versionLabel')).toContainText('Nekomate');
    const background = await page.evaluate(() => window.deskmate.identifyCourse(crypto.randomUUID(), {
      frames: [0, 15, 30].map(time => ({ image: 'data:image/jpeg;base64,/9j/2Q==', time })), source: '公开课程测试',
    }));
    expect(background.text).toContain('DESKTOP_SEARCH_MARKER');
    const courseContext = { text: background.text, attempted: true };
    const note = await page.evaluate(courseContext => window.deskmate.analyze(crypto.randomUUID(), { frame: { image: 'data:image/jpeg;base64,/9j/2Q==', time: 31 }, source: '公开课程测试', previous: [], courseContext }), courseContext);
    expect(note.text).toContain('DESKTOP_SEARCH_MARKER');
    const result = await page.evaluate(async ({ note, courseContext }) => {
      const id = crypto.randomUUID(), chunks = [];
      window.deskmate.onAnswerDelta(data => { if (data.id === id) chunks.push(data.delta); });
      const answer = await window.deskmate.ask(id, { question: '解释第二行', courseContext, analyses: [{ time: 4, text: note.text, source: '公开课程' }], transcripts: [], history: [] });
      return { answer, chunks };
    }, { note, courseContext });
    expect(result.answer.answer).toContain('DESKTOP_SEARCH_MARKER');
    expect(result.chunks.join('')).toBe(result.answer.answer);
    expect(result.chunks.join('')).not.toContain('private tool reasoning');
    expect(requests.filter(r => r.path === '/v1/tools/search')).toHaveLength(1);
    expect(requests.filter(r => r.body?.tools)).toHaveLength(2);
    expect(requests.filter(r => r.path === '/chat/completions' && !r.body.tools)).toHaveLength(2);
    expect(requests.every(r => r.auth === 'Bearer desktop-deepseek-fixture-key')).toBe(true);
    expect((await page.evaluate(() => window.deskmate.getSettings())).mode).toBe('api');
  } finally { await app?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
