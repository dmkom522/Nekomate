import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureGate, selectTranscripts } from '../src/core/learning-context.mjs';
import { pixelChange } from '../src/renderer/buffer.mjs';
import { supportsPurpose } from '../src/core/model-capabilities.mjs';
import { VisualMemory } from '../src/core/visual-memory.mjs';

test('capture waits at least 30 seconds and never repeats an unchanged slide, then resumes on change', () => {
  const gate = new CaptureGate(), dark = new Uint8ClampedArray(400), light = new Uint8ClampedArray(400).fill(255);
  assert.equal(gate.shouldRead(0, dark, pixelChange), true);
  assert.equal(gate.shouldRead(5, light, pixelChange), false);
  assert.equal(gate.shouldRead(15, light, pixelChange), false);
  assert.equal(gate.shouldRead(29.9, light, pixelChange), false);
  assert.equal(gate.shouldRead(30, light, pixelChange), true);
  assert.equal(gate.shouldRead(60, light, pixelChange), false);
  assert.equal(gate.shouldRead(1800, light, pixelChange), false);
  assert.equal(gate.shouldRead(1801, dark, pixelChange), true);
  gate.reset(); assert.equal(gate.shouldRead(0, dark, pixelChange), true);
  const memory = new VisualMemory({ analyze() {}, cancel() {} });
  memory.reset([{ time: 0, source: 'paused slide', text: 'matrix' }]);
  assert.equal(memory.select('matrix', 3600).length, 1);
});
test('restored transcript text is selected without raw audio and relevant older text remains bounded', () => {
  const transcripts = Array.from({ length: 30 }, (_, i) => ({ start: i * 10, end: i * 10 + 5, text: i === 0 ? 'eigenvalue proof' : 'other topic' }));
  const chosen = selectTranscripts(JSON.parse(JSON.stringify(transcripts)), 'eigenvalue', 300);
  assert.ok(chosen.some(t => t.text === 'eigenvalue proof'));
  assert.ok(chosen.some(t => t.start === 290)); assert.ok(chosen.length <= 12);
  assert.equal(selectTranscripts(transcripts, 'other', 2).length, 0);
});

test('an explicit gate override bypasses unchanged pixels and resets background spacing', () => {
  const gate = new CaptureGate(), pixels = new Uint8ClampedArray(400).fill(128);
  assert.equal(gate.shouldRead(0, pixels, pixelChange), true);
  assert.equal(gate.shouldRead(1, pixels, pixelChange), false);
  assert.equal(gate.shouldRead(1, pixels, pixelChange, { force: true }), true);
  assert.equal(gate.shouldRead(2, pixels, pixelChange, { force: true }), true);
  const changed = new Uint8ClampedArray(400).fill(255);
  assert.equal(gate.shouldRead(31.9, changed, pixelChange), false);
  assert.equal(gate.shouldRead(32, changed, pixelChange), true);
});
test('model lists exclude unknown, text-only, TTS, audio chat, and unsupported endpoints', () => {
  assert.equal(supportsPurpose({ id: 'unknown' }), false);
  assert.equal(supportsPurpose({ id: 'gpt-4o', input_modalities: ['text'] }), false);
  assert.equal(supportsPurpose({ id: 'custom', input_modalities: ['image'] }), true);
  assert.equal(supportsPurpose({ id: 'gpt-4o' }, 'speech'), false);
  assert.equal(supportsPurpose({ id: 'whisper-1' }, 'speech'), true);
  assert.equal(supportsPurpose({ id: 'tts-1' }, 'speech'), false);
  assert.equal(supportsPurpose({ id: 'custom', capabilities: { transcription: { supported: true } } }, 'speech'), true);
  assert.equal(supportsPurpose({ id: 'gpt-4o', supported_endpoints: ['/responses'] }), false);
});
