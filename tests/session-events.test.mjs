import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSession } from '../src/renderer/buffer.mjs';
import { CourseContext } from '../src/core/course-context.mjs';
import { sessionSummary } from '../src/renderer/session-history.mjs';

function session(extra = {}) { return { format: 'deskmate-session', version: 1, frames: [], transcripts: [], messages: [], ...extra }; }

test('a learning with only durable queued screenshots remains visible in history', () => {
  assert.equal(sessionSummary('queued', session({ diagnostics: { queuedImages: 1 } })).empty, false);
  assert.equal(sessionSummary('empty', session({ diagnostics: { queuedImages: 0 } })).empty, true);
  assert.equal(sessionSummary('invalid', session({ diagnostics: { queuedImages: '1' } })).empty, true);
});

test('saved conversation state and incremental audio identities survive validation without rewriting them', () => {
  const transcript = { eventId: 'audio:stream-a:16000:32000', audioStreamId: 'stream-a', startTotal: 16000, endTotal: 32000, start: 1, end: 2, text: '第二行减去第一行。' };
  const data = session({ sessionInitialized: true, transcripts: [transcript] });
  assert.equal(validateSession(data), data);
  assert.equal(validateSession(data).transcripts[0], transcript);
  assert.equal(validateSession(session()).sessionInitialized, undefined); // Legacy archive remains readable.
  assert.throws(() => validateSession(session({ sessionInitialized: 'ready' })), /学习会话/);
  assert.throws(() => validateSession(session({ transcripts: [{ ...transcript, endTotal: 15999 }] })), /采样范围/);
  assert.throws(() => validateSession(session({ transcripts: [{ ...transcript, audioStreamId: undefined }] })), /采样范围/);
});

test('initial course search retains screenshot event identities for backend image deduplication', async () => {
  let submitted;
  const course = new CourseContext({ identify: async (_id, input) => { submitted = input; return { text: '线性代数课程' }; }, cancel() {} });
  const frame = { image: 'data:image/png;base64,YQ==', time: 0, eventId: 'frame-a' };
  course.collect(frame, '课程');
  await course.resolve();
  assert.deepEqual(submitted.frames, [frame]);
  assert.equal(course.serialize().text, '线性代数课程');
});
