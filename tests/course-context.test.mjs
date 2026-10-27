import test from 'node:test';
import assert from 'node:assert/strict';
import { CourseContext, validateCourseContext } from '../src/core/course-context.mjs';
import { analyzeFrame, answerQuestion, identifyCourse, normalizeConfig } from '../src/core/provider.mjs';
import { localCliChat } from '../src/core/local-cli.mjs';
import { codexAppServerArgs } from '../src/core/codex-launch.mjs';
import { validateSession } from '../src/renderer/buffer.mjs';
import path from 'node:path';

const image = 'data:image/jpeg;base64,/9j/2Q==';
const frame = n => ({ image: `sample-${n}`, time: n * 15 });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('three initial samples produce one batch; later frames/questions reuse text without storing images', async () => {
  const calls = [];
  const course = new CourseContext({ identify: async (id, input) => { calls.push(input); return { text: '课程 A 背景' }; }, cancel: () => {} });
  course.collect(frame(0), 'A'); course.collect(frame(0), 'A'); course.collect(frame(1), 'A');
  assert.equal(calls.length, 0);
  course.collect(frame(2), 'A'); await settle();
  for (let i = 3; i < 20; i++) { course.collect(frame(i), 'A'); course.tick(i * 15); }
  assert.equal(calls.length, 1); assert.equal(calls[0].frames.length, 3);
  assert.deepEqual(course.serialize(), { text: '课程 A 背景', attempted: true });
  assert.deepEqual(course.frames, []);
  course.restore(course.serialize()); course.collect(frame(99), 'A'); course.tick(2000);
  assert.equal(calls.length, 1);
});

test('static slide starts one lookup after thirty seconds instead of waiting forever for changed images', async () => {
  let count = 0;
  const course = new CourseContext({ identify: async () => { count++; return { text: '静态背景' }; }, cancel: () => {} });
  course.collect(frame(0), 'A'); course.tick(29); assert.equal(count, 0);
  course.tick(30); await settle(); course.tick(300); assert.equal(count, 1);
});

test('new conversation clears background; cancelled late replies cannot contaminate the next course', async () => {
  let finish; const cancelled = [];
  const course = new CourseContext({ identify: () => new Promise(resolve => { finish = resolve; }), cancel: id => cancelled.push(id) });
  course.collect(frame(0), 'A'); course.tick(30);
  const previous = course.serialize(); assert.equal(previous.attempted, true);
  course.restore(); finish({ text: '旧课程背景' }); await settle();
  assert.equal(cancelled.length, 1); assert.equal(course.text, '');
  assert.equal(course.serialize().attempted, false);
  course.collect(frame(1), 'B'); assert.equal(course.source, 'B');
});

test('partial samples survive pause but different windows never share an initial batch; failures do not retry', async () => {
  const calls = [];
  const course = new CourseContext({ identify: async (id, input) => { calls.push(input); throw new Error('offline'); }, cancel: () => {} });
  course.collect(frame(0), 'A'); course.interrupt(); course.collect(frame(1), 'B');
  course.tick(44); assert.equal(calls.length, 0);
  course.tick(45); await settle();
  assert.equal(calls[0].frames.length, 1); assert.equal(calls[0].source, 'B');
  course.collect(frame(5), 'B'); course.tick(999); assert.equal(calls.length, 1);
  const saved = course.serialize(); course.restore(saved); course.collect(frame(7), 'B'); course.tick(999);
  assert.equal(calls.length, 1);
});

test('persisted course data is bounded and optional for legacy records', () => {
  assert.deepEqual(validateCourseContext(undefined), { text: '', attempted: false });
  assert.throws(() => validateCourseContext({ text: 'x'.repeat(6001), attempted: true }));
  assert.throws(() => validateCourseContext({ text: 'x', attempted: 'yes' }));
  assert.equal(validateCourseContext({ text: '背景', attempted: false }).attempted, true);
  const record = { format: 'deskmate-session', version: 1, frames: [], transcripts: [], messages: [] };
  assert.equal(validateSession(record), record);
  assert.throws(() => validateSession({ ...record, courseContext: { text: {}, attempted: true } }));
});

test('ordinary DeepSeek notes and answers carry saved course background as data without any search tools', async () => {
  const requests = [], config = normalizeConfig({ vision: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } });
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    assert.ok(url.endsWith('/chat/completions')); assert.equal(body.tools, undefined);
    assert.ok(JSON.stringify(body.messages.filter(m => m.role === 'user')).includes('COURSE_BACKGROUND_MARKER'));
    assert.equal(JSON.stringify(body.messages.filter(m => m.role === 'system')).includes('COURSE_BACKGROUND_MARKER'), false);
    return Response.json({ choices: [{ message: { content: '基于已保存背景回答' }, finish_reason: 'stop' }] });
  };
  const courseContext = { text: 'COURSE_BACKGROUND_MARKER', attempted: true };
  await analyzeFrame(config, { frame: { image, time: 1 }, source: 'A', previous: [], courseContext }, undefined, fetch);
  await answerQuestion(config, { question: '这里为什么', courseContext }, undefined, fetch);
  assert.equal(requests.length, 2);
});

test('providers without web tools identify only supplied image background and never claim a search', async () => {
  const config = normalizeConfig({ vision: { provider: 'custom', baseUrl: 'https://example.com/v1', model: 'vision' } });
  await identifyCourse(config, { frames: [{ image, time: 0 }], source: 'A' }, undefined, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined); assert.match(JSON.stringify(body.messages.at(-1)), /本次没有联网工具/);
    return Response.json({ choices: [{ message: { content: '画面主题是矩阵，具体课程未知。' }, finish_reason: 'stop' }] });
  });
  await assert.rejects(identifyCourse(config, { frames: Array(4).fill({ image, time: 0 }), source: 'A' }), /1–3/);
});

test('Claude and Codex enable public web tools only for explicitly requested course discovery', async () => {
  assert.ok(codexAppServerArgs().includes('web_search="disabled"'));
  assert.ok(codexAppServerArgs({ allowWeb: true }).includes('web_search="live"'));
  const resolver = async () => ({ executable: process.execPath, prefix: [path.resolve('tests/fixtures/local-cli.mjs'), 'claude'] });
  for (const allowWeb of [false, true]) {
    const result = await localCliChat({ kind: 'claude' }, [{ role: 'user', content: '识别课程' }], undefined, { resolver, allowWeb });
    const { args } = JSON.parse(result.text);
    assert.equal(args[args.indexOf('--tools') + 1], allowWeb ? 'WebSearch,WebFetch' : '');
    assert.equal(args[args.indexOf('--disallowedTools') + 1], allowWeb ? 'Bash,Read,Write,Edit,Glob,Grep,Agent,Task,mcp__*' : '*');
  }
});
