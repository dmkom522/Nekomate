import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsSystemAudio, speechPythonPath } from '../src/core/platform.mjs';

test('system audio is offered only on Windows and macOS with CoreAudio Tap support', () => {
  assert.equal(supportsSystemAudio('win32', '10.0'), true);
  assert.equal(supportsSystemAudio('linux', '6.8'), false);
  assert.equal(supportsSystemAudio('darwin', '22.6.0'), false);
  assert.equal(supportsSystemAudio('darwin', '23.1.0'), false);
  assert.equal(supportsSystemAudio('darwin', '23.2.0'), true);
  assert.equal(supportsSystemAudio('darwin', '25.0.0'), true);
  assert.equal(supportsSystemAudio('darwin', 'invalid'), false);
});

test('the speech worker uses the bundled interpreter for its target operating system', () => {
  assert.match(speechPythonPath('/bundle', 'darwin'), /python\/bin\/python3$/);
  assert.match(speechPythonPath('/bundle', 'win32'), /python\/python.exe$/);
});
