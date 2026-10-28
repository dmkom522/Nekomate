import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';
import { encodeWav } from '../src/core/audio-buffer.mjs';

const run = promisify(execFile), require = createRequire(import.meta.url), asar = require('@electron/asar');
if (process.platform !== 'darwin') throw new Error('Run the DMG smoke test on macOS');
const dmg = path.resolve(process.argv[2]);
const mount = path.resolve('.local', `macos-mount-${process.arch}`);
await mkdir(mount, { recursive: true }); await mkdir('test-results', { recursive: true });
let mounted = false, app;
const report = { architecture: process.arch, dmg, checks: [], speech: [] };
try {
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { timeout: 120000 }); mounted = true;
  const bundle = path.join(mount, 'Nekomate.app'), resources = path.join(bundle, 'Contents/Resources');
  const archive = path.join(resources, 'app.asar');
  const expected = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, expected.version);
  assert.ok(asar.extractFile(archive, 'src/core/prompts.mjs').equals(await readFile('src/core/prompts.mjs')));
  await run('codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120000 });
  report.checks.push('DMG mounts; app version and prompts match source; ad-hoc signature validates');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Nekomate'), env, timeout: 60000 });
  const page = await app.firstWindow(); await page.waitForLoadState('load');
  await page.waitForFunction(() => Boolean(window.deskmate?.info));
  report.info = await page.evaluate(() => window.deskmate.info());
  assert.equal(report.info.platform, 'darwin'); assert.equal(report.info.version, expected.version); assert.equal(report.info.systemAudioSupported, true);
  await page.evaluate(() => window.deskmate.setLanguage('en'));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).show());
  await page.screenshot({ path: `test-results/macos-${process.arch}.png` });
  report.checks.push('Mounted packaged app starts, IPC works, English UI opens');
  for (const language of ['zh', 'en']) {
    const bytes = await readFile(`tests/fixtures/mac-speech-${language}.wav`);
    const start = performance.now();
    const result = await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      return window.deskmate.transcribe(crypto.randomUUID(), bytes, 'audio/wav');
    }, bytes.toString('base64'));
    assert.equal(result.source, 'local'); assert.match(result.model, /^Qwen3-ASR/);
    if (language === 'zh') assert.match(result.text, /线性代数/); else assert.match(result.text.toLowerCase(), /linear algebra/);
    if (result.mode === 'gpu') { assert.ok(result.gpuLayers > 0); assert.ok(result.devices.some(name => /Metal|MTL|Apple/.test(name))); }
    report.speech.push({ language, ...result, elapsedMs: Math.round(performance.now() - start) });
    console.log(JSON.stringify(report.speech.at(-1)));
  }
  const silence = Buffer.from(encodeWav({ samples: new Float32Array(16000 * 120), sampleRate: 16000 }));
  const quiet = await page.evaluate(async base64 => window.deskmate.transcribe(crypto.randomUUID(), Uint8Array.from(atob(base64), char => char.charCodeAt(0)), 'audio/wav'), silence.toString('base64'));
  assert.equal(quiet.text, ''); assert.deepEqual(quiet.segments, []);
  report.checks.push('Actual packaged worker transcribes known Chinese and English speech and returns no invented text for 120 seconds of silence');
  report.notVerified = ['User-approved screen capture and CoreAudio loopback on a personal Mac', 'Developer ID signing and Apple notarization', 'Accuracy on arbitrary human course recordings'];
  await writeFile(`test-results/macos-${process.arch}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (app) await app.close();
  if (mounted) await run('hdiutil', ['detach', mount]);
}
