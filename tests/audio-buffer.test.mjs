import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioRing, encodeWav } from '../src/core/audio-buffer.mjs';

test('ring removes expired samples and preserves channel mix and chronological order across wraps', () => {
  const ring = new AudioRing(2, 3);
  ring.append([Float32Array.from([1, 2, 3, 4]), Float32Array.from([3, 4, 5, 6])]);
  assert.deepEqual([...ring.snapshot().samples], [2, 3, 4, 5]);
  const frozen = ring.snapshot();
  ring.append([Float32Array.from([6, 7, 8, 9, 10, 11, 12, 13])]);
  assert.deepEqual([...ring.snapshot().samples], [8, 9, 10, 11, 12, 13]);
  assert.deepEqual([...frozen.samples], [2, 3, 4, 5]);
  assert.equal(ring.snapshot().total, 12);
});

test('two-minute WAV contains the latest tone samples, with correct duration and no old prefix', () => {
  const rate = 16000, ring = new AudioRing(rate);
  // Feed 125 seconds of source samples, with distinguishable old/new content.
  for (let second = 0; second < 125; second++) {
    const frequency = second < 5 ? 440 : 880;
    ring.append([Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * i / rate))]);
  }
  const snapshot = ring.snapshot(), wav = new DataView(encodeWav(snapshot));
  assert.equal(snapshot.samples.length, rate * 120);
  assert.equal(wav.getUint32(40, true), rate * 120 * 2);
  assert.equal(wav.byteLength, 44 + rate * 120 * 2);
  for (const start of [0, rate * 119]) {
    let crossings = 0;
    for (let i = start + 1; i < start + rate; i++) {
      if (wav.getInt16(44 + (i - 1) * 2, true) < 0 && wav.getInt16(44 + i * 2, true) >= 0) crossings++;
    }
    assert.ok(Math.abs(crossings - 880) <= 1);
  }
});

test('WAV uses only available samples for short sessions and clamps PCM without wrapping', () => {
  const samples = Float32Array.from([-2, -1, 0, 1, 2]);
  const view = new DataView(encodeWav({ samples, sampleRate: 16000 }));
  assert.equal(view.byteLength, 54);
  assert.deepEqual(samples.map((_, i) => view.getInt16(44 + i * 2, true)), Float32Array.from([-32768, -32768, 0, 32767, 32767]));
});
