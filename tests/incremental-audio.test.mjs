import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioRing, encodeWav, sliceUntranscribedAudio } from '../src/core/audio-buffer.mjs';

test('incremental slices contain only samples after the prepared position and do not mutate progress', () => {
  const ring = new AudioRing(4, 120);
  ring.append([Float32Array.from([0.1, 0.2, 0.3, 0.4])]);
  const first = sliceUntranscribedAudio(ring.snapshot());
  assert.equal(first.startTotal, 0); assert.equal(first.endTotal, 4);
  ring.append([Float32Array.from([0.5, 0.6, 0.7, 0.8])]);
  const snapshot = ring.snapshot(), cursor = first.endTotal;
  const second = sliceUntranscribedAudio(snapshot, cursor);
  assert.equal(cursor, 4); assert.equal(second.total, 8);
  assert.equal(second.startTotal, 4); assert.equal(second.endTotal, 8);
  assert.deepEqual([...second.samples], [...Float32Array.from([0.5, 0.6, 0.7, 0.8])]);
  assert.equal(second.missingSamples, 0);
  assert.equal(sliceUntranscribedAudio(snapshot, second.endTotal).samples.length, 0);
  assert.deepEqual([...first.samples], [...Float32Array.from([0.1, 0.2, 0.3, 0.4])]);
  second.samples[0] = 1;
  assert.notEqual(snapshot.samples[4], 1); // The staged clip owns its samples.
});

test('retrying an uncommitted range returns the same PCM; later samples are not silently acknowledged', () => {
  const ring = new AudioRing(8, 120);
  ring.append([Float32Array.from({ length: 16 }, (_, i) => (i - 8) / 10)]);
  const snapshot = ring.snapshot(), first = sliceUntranscribedAudio(snapshot, 4);
  const retry = sliceUntranscribedAudio(snapshot, 4);
  assert.deepEqual(new Uint8Array(encodeWav(first)), new Uint8Array(encodeWav(retry)));
  ring.append([Float32Array.from([0.2, 0.3])]);
  const afterFailure = sliceUntranscribedAudio(ring.snapshot(), 4);
  assert.equal(afterFailure.startTotal, 4); assert.equal(afterFailure.samples.length, 14);
  const afterPreparedText = sliceUntranscribedAudio(ring.snapshot(), first.endTotal);
  assert.deepEqual([...afterPreparedText.samples], [...Float32Array.from([0.2, 0.3])]);
});

test('expired unprocessed audio is reported as a gap and never fabricated before the retained ring', () => {
  const ring = new AudioRing(2, 3);
  ring.append([Float32Array.from({ length: 10 }, (_, i) => i)]);
  const clip = sliceUntranscribedAudio(ring.snapshot(), 2);
  assert.equal(clip.retainedStartTotal, 4);
  assert.equal(clip.startTotal, 4); assert.equal(clip.endTotal, 10);
  assert.equal(clip.missingSamples, 2); assert.equal(clip.missingSeconds, 1);
  assert.deepEqual([...clip.samples], [4, 5, 6, 7, 8, 9]);
  assert.equal(clip.samples.length, ring.buffer.length);
});

test('a 130-second source produces a 120-second first clip and then only the new ten-second PCM', () => {
  const rate = 16000, ring = new AudioRing(rate);
  const tone = frequency => Float32Array.from({ length: rate }, (_, i) => 0.4 * Math.sin(2 * Math.PI * frequency * i / rate));
  for (let second = 0; second < 130; second++) ring.append([tone(440)]);
  const initial = sliceUntranscribedAudio(ring.snapshot());
  assert.equal(initial.startTotal, 10 * rate); assert.equal(initial.samples.length, 120 * rate);
  for (let second = 0; second < 10; second++) ring.append([tone(880)]);
  const increment = sliceUntranscribedAudio(ring.snapshot(), initial.endTotal);
  assert.equal(increment.startTotal, 130 * rate); assert.equal(increment.endTotal, 140 * rate);
  assert.equal(increment.samples.length, 10 * rate);
  const wav = new DataView(encodeWav(increment));
  assert.equal(wav.getUint32(40, true), 10 * rate * 2);
  assert.equal(wav.byteLength, 44 + 10 * rate * 2);
  for (const start of [0, 9 * rate]) {
    let crossings = 0;
    for (let i = start + 1; i < start + rate; i++) {
      if (wav.getInt16(44 + (i - 1) * 2, true) < 0 && wav.getInt16(44 + i * 2, true) >= 0) crossings++;
    }
    assert.ok(Math.abs(crossings - 880) <= 1);
  }
});

test('invalid or restarted stream positions fail rather than replaying the old stream silently', () => {
  const snapshot = { samples: new Float32Array(4), sampleRate: 16000, total: 4 };
  for (const cursor of [-1, 0.5, 5, NaN, Infinity]) assert.throws(() => sliceUntranscribedAudio(snapshot, cursor), /音频进度/);
  for (const invalid of [null, {}, { ...snapshot, total: 3 }, { ...snapshot, sampleRate: 0 }, { ...snapshot, samples: [0] }]) {
    assert.throws(() => sliceUntranscribedAudio(invalid), /快照格式/);
  }
});
