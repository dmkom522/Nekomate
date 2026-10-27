import test from 'node:test';
import assert from 'node:assert/strict';
import { VisualMemory, VisualFrameQueue, validateNotes } from '../src/core/visual-memory.mjs';
import { analyzeFrame, answerQuestion } from '../src/core/provider.mjs';
import { validateSession } from '../src/renderer/buffer.mjs';

const frame = { image: 'data:image/jpeg;base64,/9j/2Q==', time: 1 };
const note = (time, text = '矩阵 A 的第二行消元') => ({ time, text, source: 'course' });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('queued images preserve FIFO content until a successful read, with bounded memory and no silent eviction', () => {
  const notices = [], queue = new VisualFrameQueue({ maxFrames: 2, maxBytes: 1000, onFull: () => notices.push('full') });
  queue.enqueue(frame, 'A'); const first = queue.peek();
  const next = { time: 16, image: 'different-image' }; queue.enqueue(next, 'B');
  assert.equal(queue.enqueue({ time: 31, image: 'third' }, 'B'), false);
  assert.equal(queue.enqueue({ time: 46, image: 'fourth' }, 'B'), false);
  assert.equal(notices.length, 1); assert.equal(queue.peek().frame.image, frame.image);
  queue.complete({ ...first }); assert.equal(queue.frames.length, 2);
  queue.complete(first); assert.deepEqual(queue.peek().frame, next); assert.equal(queue.peek().source, 'B');
  const bytes = queue.bytes; assert.equal(bytes, next.image.length * 2);
  queue.clear(); assert.equal(queue.bytes, 0); assert.equal(queue.peek(), undefined);
  const small = new VisualFrameQueue({ maxBytes: 10 });
  assert.equal(small.enqueue(frame, 'A'), false); assert.equal(small.bytes, 0);
});

test('an interrupted background frame stays queued before newer images and stale completion cannot consume it', async () => {
  const queue = new VisualFrameQueue(), old = deferred(), retried = deferred(); let count = 0;
  const memory = new VisualMemory({ analyze: () => (++count === 1 ? old.promise : retried.promise), cancel() {} });
  queue.enqueue(frame, 'course'); const entry = queue.peek();
  memory.submit(entry.frame, entry.source); const stopped = memory.pending.done;
  memory.interrupt(); queue.enqueue({ ...frame, time: 16, image: 'later' }, 'course');
  memory.submit(entry.frame, entry.source); const current = memory.pending.done;
  old.resolve({ text: 'stale' }); if (await stopped) queue.complete(entry);
  assert.equal(queue.peek(), entry); assert.equal(memory.notes.length, 0);
  retried.resolve({ text: 'current' }); if (await current) queue.complete(entry);
  assert.equal(queue.peek().frame.image, 'later'); assert.equal(memory.notes[0].text, 'current');
});

test('slow reader allows only one screenshot and keeps actual returned notes', async () => {
  const work = deferred(), calls = [];
  const memory = new VisualMemory({ analyze: (id, input) => { calls.push(input); return work.promise; }, cancel: () => {} });
  assert.equal(memory.submit(frame, 'course'), true);
  assert.equal(memory.ready, false);
  assert.equal(memory.submit({ ...frame, time: 2 }, 'course'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].frame.image, frame.image);
  work.resolve({ text: '读取结果：第二行 [0, 1 | 2]' });
  assert.deepEqual(await memory.pending.done, note(1, '读取结果：第二行 [0, 1 | 2]'));
  assert.equal(memory.ready, true);
  assert.deepEqual(memory.notes, [note(1, '读取结果：第二行 [0, 1 | 2]')]);
});

test('stopping or resetting ignores a late result from the previous session', async () => {
  const old = deferred(), next = deferred(), cancelled = []; let calls = 0;
  const memory = new VisualMemory({ analyze: () => (++calls === 1 ? old.promise : next.promise), cancel: id => cancelled.push(id) });
  memory.submit(frame, 'old'); const first = memory.pending.done;
  memory.reset(); memory.submit({ ...frame, time: 3 }, 'new'); const second = memory.pending.done;
  old.resolve({ text: '过期笔记' }); await first;
  assert.equal(memory.notes.length, 0); assert.equal(memory.ready, false); assert.equal(cancelled.length, 1);
  next.resolve({ text: '新课笔记' }); await second;
  assert.deepEqual(memory.notes, [{ time: 3, source: 'new', text: '新课笔记' }]);
});

test('read errors pause repeated billing until explicit retry', async () => {
  const errors = [], work = deferred();
  const memory = new VisualMemory({ analyze: () => work.promise, cancel: () => {}, onError: error => errors.push(error.message) });
  memory.submit(frame, 'course'); const done = memory.pending.done;
  work.reject(new Error('API 429')); await done;
  assert.equal(memory.ready, false); assert.equal(memory.submit(frame, 'course'), false);
  assert.deepEqual(errors, ['API 429']); assert.equal(memory.lastError, 'API 429');
  memory.retry(); assert.equal(memory.ready, true); assert.equal(memory.lastError, '');
});

test('recall combines recent notes and relevant older evidence within bounded history', () => {
  const memory = new VisualMemory({ analyze: () => {}, cancel: () => {} });
  memory.reset(Array.from({ length: 40 }, (_, i) => note(i, i === 2 ? '行列式 determinant 为零' : '矩阵一般步骤')));
  const selected = memory.select('determinant 为什么是零', 40);
  assert.equal(selected[0].time, 2); assert.equal(selected.at(-1).time, 39); assert.ok(selected.length <= 18);
  assert.deepEqual(memory.select('x', 2000).map(n => n.time), [39]); // last static slide remains useful
});

test('pre-read request contains one image, answer reuses text notes with no images', async () => {
  const config = { vision: { baseUrl: 'https://example.com/v1', model: 'vision' } }, payloads = [];
  const fetch = async (_url, request) => { payloads.push(JSON.parse(request.body)); return Response.json({ choices: [{ message: { content: '第二行：[0, 1 | 2]' } }] }); };
  const result = await analyzeFrame(config, { frame, source: 'course', previous: [] }, null, fetch);
  const answer = await answerQuestion(config, { question: '为什么？', currentTime: 2, analyses: [note(1, result.text)] }, null, fetch);
  assert.equal(payloads[0].messages.at(-1).content.filter(p => p.type === 'image_url').length, 1);
  assert.equal(payloads[1].messages.at(-1).content.filter(p => p.type === 'image_url').length, 0);
  assert.ok(payloads[1].messages.at(-1).content.some(p => p.text?.includes(result.text)));
  assert.equal(answer.sources[0].type, 'visual-note');
  assert.match(payloads[1].messages[0].content, /只有画面理解笔记时/);
});

test('session notes survive validation and malformed notes are rejected', () => {
  const session = { format: 'deskmate-session', version: 1, frames: [], transcripts: [], messages: [], analyses: [note(1)] };
  assert.deepEqual(validateSession(session).analyses, [note(1)]);
  assert.throws(() => validateSession({ ...session, analyses: [note(-1)] }));
  assert.throws(() => validateNotes([note(1, 'x'.repeat(4001))]));
});

test('lecture archives retain old notes and long conversations while request selection remains bounded', async () => {
  const memory = new VisualMemory({ analyze: async () => ({ text: '最新板书' }), cancel: () => {} });
  const archive = Array.from({ length: 500 }, (_, i) => note(i * 15, i === 0 ? '特征值 eigenvalue 的定义' : `第${i}步`));
  memory.reset(archive);
  memory.submit({ ...frame, time: 8000 }, 'course'); await memory.pending.done;
  assert.equal(memory.notes.length, 501);
  assert.equal(memory.notes[0].text, '特征值 eigenvalue 的定义');
  const selected = memory.select('eigenvalue 定义是什么', 8000);
  assert.ok(selected.some(n => n.time === 0));
  assert.equal(selected.at(-1).time, 8000);
  assert.ok(selected.length <= 18);
  const session = { format: 'deskmate-session', version: 1, frames: [], analyses: memory.notes,
    transcripts: Array.from({ length: 2001 }, (_, i) => ({ start: i, end: i + 1, text: `讲解${i}` })),
    messages: Array.from({ length: 402 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `对话${i}` })) };
  const restored = validateSession(JSON.parse(JSON.stringify(session)));
  assert.equal(restored.analyses.length, 501); assert.equal(restored.transcripts.length, 2001); assert.equal(restored.messages.length, 402);
  assert.equal(restored.messages[0].text, '对话0');
});
