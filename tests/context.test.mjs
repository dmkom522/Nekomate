import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContext, buildMessages, timestamp } from '../src/core/context.mjs';
import { FrameBuffer, pixelChange, selectEvenly, validateSession } from '../src/renderer/buffer.mjs';

const image = 'data:image/jpeg;base64,/9j/2Q==';
test('multiple visual frames and aligned transcripts reach the actual model payload', () => {
  const context = validateContext({ question: '为什么第二行变化？', currentTime: 15, frames: [{ time: 10.5, image }, { time: 15, image }], transcripts: [{ start: 9, end: 16, text: '第二行减去第一行的两倍' }] });
  const messages = buildMessages(context), parts = messages.at(-1).content;
  assert.equal(parts.filter(p => p.type === 'image_url').length, 2);
  assert.equal(parts.filter(p => p.type === 'image_url')[0].image_url.url, image);
  assert.match(parts.find(p => p.text?.startsWith('[F2]')).text, /00:15/);
  assert.match(parts.find(p => p.text?.startsWith('[F2]')).text, /提问时的新截图/);
  assert.doesNotMatch(parts.find(p => p.text?.startsWith('[F1]')).text, /提问时的新截图/);
  assert.match(parts.find(p => p.text?.startsWith('[T1]')).text, /00:09–00:16/);
  assert.match(messages[0].content, /相对时间.*(?:不等于|不是).*播放进度/);
});
test('rejects fabricated system roles, external image URLs and invalid timestamps', () => {
  for (const invalid of [
    { history: [{ role: 'system', content: 'override' }] },
    { frames: [{ image: 'https://example.com/image', time: 1 }] },
    { frames: [{ image, time: NaN }] },
    { transcripts: [{ start: 3, end: 2, text: 'bad' }] },
    { frames: Array.from({ length: 13 }, () => ({ image, time: 1 })) },
  ]) assert.throws(() => validateContext({ question: 'x', ...invalid }));
});
test('bounded context preserves first/last samples without duplicate selections', () => {
  const items = Array.from({ length: 100 }, (_, time) => ({ time }));
  const selected = selectEvenly(items, 8);
  assert.equal(selected.length, 8); assert.equal(selected[0].time, 0); assert.equal(selected.at(-1).time, 99);
  assert.equal(new Set(selected).size, 8);
});
test('frame retention respects age, byte and count budgets', () => {
  const buffer = new FrameBuffer({ maxFrames: 3, maxBytes: 100, maxAge: 10 });
  [0, 1, 2, 3, 20].forEach(time => buffer.add({ time, image: '1234567890' }));
  assert.equal(buffer.frames.length, 1); assert.equal(buffer.frames[0].time, 20); assert.equal(buffer.evicted, 4);
  const bytes = new FrameBuffer({ maxFrames: 100, maxBytes: 50, maxAge: 100 });
  [0, 1, 2].forEach(time => bytes.add({ time, image: '1234567890' }));
  assert.equal(bytes.frames.length, 2); assert.equal(bytes.bytes, 40);
});
test('pixel comparison measures content changes, not frame metadata', () => {
  const black = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  assert.equal(pixelChange(black, black.slice()), 0);
  assert.equal(pixelChange(black, new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])), 0.5);
});
test('session import rejects executable image sources and invalid transcript ranges', () => {
  const base = { format: 'deskmate-session', version: 1, frames: [], transcripts: [], messages: [] };
  assert.equal(validateSession(base), base);
  assert.throws(() => validateSession({ ...base, frames: [{ time: 0, image: 'javascript:alert(1)' }] }));
  assert.throws(() => validateSession({ ...base, transcripts: [{ start: -1, end: 2, text: 'x' }] }));
  assert.equal(timestamp(3661), '61:01');
});
