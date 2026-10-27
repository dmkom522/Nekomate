import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { petGeometry, clickEars } from './pet-geometry.mjs';

async function dockAt(app, pet, edge) {
  await expect(pet.locator('body')).toHaveAttribute('data-docked', '');
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    pet.setBounds({ x: area.x + 200, y: area.y + 200, width: 126, height: 118 });
    globalThis.restoreCursor = { x: area.x + 240, y: area.y + 240 };
  });
  await pet.evaluate(() => window.pet.action('drag-start'));
  await app.evaluate(({ screen }, edge) => {
    const area = screen.getPrimaryDisplay().bounds;
    globalThis.restoreCursor = {
      x: edge === 'left' ? area.x : edge === 'right' ? area.x + area.width - 40 : area.x + 240,
      y: edge === 'top' ? area.y : edge === 'bottom' ? area.y + area.height - 40 : area.y + 240,
    };
  }, edge);
  await pet.evaluate(() => window.pet.action('drag-move'));
  await pet.evaluate(() => window.pet.action('drag-end'));
  await expect(pet.locator('body')).toHaveAttribute('data-docked', edge);
  await expect.poll(() => pet.locator('body').getAttribute('data-motion')).toBeNull();
  return petGeometry(app);
}

async function prepareNearbyForehead(app, pet, edge, bounds) {
  // DOM hover is deliberately absent: the real main-process timer must establish proximity.
  await pet.mouse.move(-100, -100);
  const reads = await app.evaluate(({ screen }, { edge, bounds }) => {
    globalThis.restoreCursor = {
      x: edge === 'left' ? bounds.x + bounds.width + 17 : edge === 'right' ? bounds.x - 17 : bounds.x + bounds.width / 2,
      y: edge === 'top' ? bounds.y + bounds.height + 17 : edge === 'bottom' ? bounds.y - 17 : bounds.y + bounds.height / 2,
    };
    return globalThis.restoreCursorReads;
  }, { edge, bounds });
  await expect.poll(() => app.evaluate(() => globalThis.restoreCursorReads)).toBeGreaterThan(reads);
  await expect(pet.locator('body')).toHaveAttribute('data-peeking', 'true');
  await expect.poll(() => pet.locator('.dock-head').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42)).toBeCloseTo(12, 2);
  await pet.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function installDiagnostics(app, pet) {
  await app.evaluate(({ BrowserWindow, screen }) => {
    globalThis.restoreCursor = { x: 300, y: 300 }; globalThis.restoreCursorReads = 0;
    screen.getCursorScreenPoint = () => { globalThis.restoreCursorReads++; return globalThis.restoreCursor; };
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    const setBounds = pet.setBounds.bind(pet);
    globalThis.restoreNative = { active: false, edge: '', records: [] };
    const record = (phase, requested) => {
      if (globalThis.restoreNative.active) globalThis.restoreNative.records.push({ at: Date.now(), phase, requested, bounds: pet.getBounds() });
    };
    pet.setBounds = (bounds, ...args) => {
      record('setBounds-before', { ...bounds });
      const result = setBounds(bounds, ...args);
      record('setBounds-after', { ...bounds }); return result;
    };
    pet.on('move', () => record('native-move'));
    pet.on('resize', () => record('native-resize'));
  });
  await pet.evaluate(() => {
    window.restoreDiagnostic = { active: false, edge: '', records: [] };
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { local: { x: value.x, y: value.y, width: value.width, height: value.height },
        screen: { x: window.screenX + value.x, y: window.screenY + value.y, width: value.width, height: value.height } };
    };
    window.restoreSnapshot = (phase, rafTime = null) => {
      const elements = {};
      for (const [name, selector] of [['cat', '.cat-art'], ['peek', '.dock-peek'], ['head', '.dock-head']]) {
        const element = document.querySelector(selector), style = getComputedStyle(element);
        const matrix = new DOMMatrixReadOnly(style.transform);
        const opacityAnimations = element.getAnimations().filter(animation => animation.playState === 'running' || animation.pending)
          .filter(animation => animation.effect?.getKeyframes().some(frame => Object.hasOwn(frame, 'opacity')))
          .map(animation => ({ playState: animation.playState, pending: animation.pending, currentTime: animation.currentTime }));
        elements[name] = { display: style.display, visibility: style.visibility, opacity: Number(style.opacity), transform: style.transform,
          translation: { x: matrix.m41, y: matrix.m42 }, opacityAnimations, ...rect(element) };
      }
      return { at: Date.now(), rafTime, phase, width: innerWidth, height: innerHeight,
        screenX: window.screenX, screenY: window.screenY, devicePixelRatio,
        docked: document.body.dataset.docked ?? '', peeking: document.body.dataset.peeking ?? '', motion: document.body.dataset.motion ?? '',
        motionPhase: document.body.dataset.motionPhase ?? '', elements };
    };
    const record = (phase, rafTime) => {
      if (window.restoreDiagnostic.active) window.restoreDiagnostic.records.push(window.restoreSnapshot(phase, rafTime));
    };
    const frame = time => { record('raf', time); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    window.addEventListener('resize', () => record('resize'));
    for (const event of ['pointerdown', 'pointerup', 'click']) document.addEventListener(event, () => record(event), true);
  });
}

function assertCatDrawability({ edge, renderer }) {
  const intermediate = renderer.records.filter(record => record.phase === 'raf' && record.motion === 'restoring'
    && record.motionPhase === 'play' && record.elements.cat.opacity > .02 && record.elements.cat.opacity < .98);
  expect(intermediate.length, `${edge}: normal restoration must include intermediate cat frames`).toBeGreaterThan(0);
  // Animated opacity does not imply painted pixels when a more-specific rule hides the SVG.
  // These conditions catch that regression; screen/window pixel evidence is still separate.
  for (const record of intermediate) {
    const cat = record.elements.cat;
    expect(cat.display, `${edge}: an intermediate cat frame cannot be display:none`).not.toBe('none');
    expect(cat.visibility, `${edge}: an intermediate cat frame must be visible`).toBe('visible');
    expect(cat.local.width, `${edge}: the intermediate cat has drawable geometry`).toBeGreaterThan(0);
    expect(cat.local.height, `${edge}: the intermediate cat has drawable geometry`).toBeGreaterThan(0);
  }
}

function assertRestoreContinuity({ edge, dockedBounds, stableViewport, renderer, native, reducedMotion = false }) {
  if (!reducedMotion) assertCatDrawability({ edge, renderer });
  const records = renderer.records;
  const baseline = records.find(record => record.phase === 'before-click');
  expect(baseline, `${edge}: a stable forehead baseline was recorded`).toBeTruthy();
  const baselineHead = baseline.elements.head.translation.y;
  expect(baselineHead, `${edge}: baseline forehead offset`).toBeCloseTo(12, 2);
  const restoring = records.filter(record => record.motion === 'restoring');
  for (const phase of ['prepare', 'play', 'settle'])
    expect(records.some(record => record.motionPhase === phase), `${edge}: renderer observed restoring ${phase}`).toBe(true);

  const visiblePeek = record => record.elements.peek.display !== 'none' && record.elements.peek.visibility !== 'hidden' && record.elements.peek.opacity > .02;
  const visibleRestoring = restoring.filter(visiblePeek);
  expect(visibleRestoring.length, `${edge}: restoration includes visible ear frames`).toBeGreaterThan(0);
  for (const record of visibleRestoring)
    expect(Math.abs(record.elements.head.translation.y - baselineHead), `${edge}: forehead cannot retract before restoring (${record.phase}/${record.motionPhase})`).toBeLessThanOrEqual(.2);

  const prepared = restoring.filter(record => record.motionPhase === 'prepare' && record.phase === 'raf');
  expect(prepared.length, `${edge}: preparation reaches the renderer`).toBeGreaterThan(0);
  if (stableViewport) {
    expect(native.records, `${edge}: restoring never moves or resizes the native window`).toEqual([]);
    for (const record of records) {
      expect(Math.abs(record.width - dockedBounds.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(record.height - dockedBounds.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(record.screenX - dockedBounds.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(record.screenY - dockedBounds.y)).toBeLessThanOrEqual(1);
    }
  } else {
    const expansion = native.records.find(record => record.phase === 'setBounds-before'
      && (record.requested.width > dockedBounds.width + 1 || record.requested.height > dockedBounds.height + 1));
    expect(expansion, `${edge}: the legacy native window expanded for restoration`).toBeTruthy();
    expect(prepared.some(record => record.at <= expansion.at), `${edge}: preparation precedes expansion`).toBe(true);
  }

  const baselineRect = baseline.elements.peek.screen;
  const stationary = restoring.filter(record => record.motionPhase === 'prepare');
  const firstPlay = restoring.find(record => record.motionPhase === 'play');
  if (firstPlay) stationary.push(firstPlay);
  for (const record of stationary.filter(visiblePeek)) for (const key of ['x', 'y', 'width', 'height'])
    expect(Math.abs(record.elements.peek.screen[key] - baselineRect[key]), `${edge}: stationary first-frame peek ${key} (${record.phase}/${record.motionPhase})`).toBeLessThanOrEqual(1.5);

  const lastRestoringIndex = records.findLastIndex(record => record.motion === 'restoring');
  const complete = records.slice(lastRestoringIndex + 1).filter(record => !record.motion && !record.docked);
  expect(complete.filter(record => record.phase === 'raf').length, `${edge}: completed cat remains observable for multiple frames`).toBeGreaterThanOrEqual(2);
  for (const record of complete) {
    expect(record.elements.cat.display, `${edge}: completed cat is visible`).not.toBe('none');
    expect(record.elements.cat.opacity, `${edge}: completion cannot start another fade`).toBeGreaterThanOrEqual(.99);
    expect(record.elements.cat.opacityAnimations, `${edge}: no extra opacity animation after settlement`).toEqual([]);
  }
}

test('forehead-to-cat restoration preserves the first frame and completes without another fade on all four edges', async () => {
  test.setTimeout(90000);
  const output = path.resolve('.local'); await mkdir(output, { recursive: true });
  const profile = await mkdtemp(path.join(output, 'pet-restore-profile-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    await expect.poll(() => app.windows().some(page => page.url().endsWith('/pet.html'))).toBe(true);
    const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
    await expect(pet.locator('#petState')).toHaveText('点我提问');
    await pet.emulateMedia({ reducedMotion: 'no-preference' });
    await installDiagnostics(app, pet);

    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const { bounds: dockedBounds, ears, stableViewport } = await dockAt(app, pet, edge);
      await prepareNearbyForehead(app, pet, edge, ears);
      await app.evaluate((_electron, edge) => { globalThis.restoreNative = { active: true, edge, records: [] }; }, edge);
      await pet.evaluate(edge => {
        window.restoreDiagnostic = { active: true, edge, records: [] };
        window.restoreDiagnostic.records.push(window.restoreSnapshot('before-click'));
      }, edge);

      const baseline = await app.evaluate(async ({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
        const image = await pet.webContents.capturePage();
        return { at: Date.now(), bounds: pet.getBounds(), size: image.getSize(), png: image.toPNG().toString('base64') };
      });
      const baselinePath = path.join(output, `pet-restore-${edge}-00-before.png`);
      await writeFile(baselinePath, Buffer.from(baseline.png, 'base64'));

      // capturePage samples the rendered pet window while Playwright sends a real pointer click.
      const capturesPromise = app.evaluate(async ({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
        const { createHash } = process.getBuiltinModule('crypto'), frames = [];
        for (let index = 0; index < 20; index++) {
          const started = Date.now(), beforeBounds = pet.getBounds();
          const image = await pet.webContents.capturePage();
          const captured = Date.now(), afterBounds = pet.getBounds();
          const snapshot = await pet.webContents.executeJavaScript('window.restoreSnapshot("capture")');
          frames.push({ index: index + 1, started, captured, beforeBounds, afterBounds, snapshot,
            size: image.getSize(), hash: createHash('sha256').update(image.toBitmap()).digest('hex'), png: image.toPNG().toString('base64') });
          await new Promise(resolve => setTimeout(resolve, 12));
        }
        return frames;
      });
      const [frames] = await Promise.all([capturesPromise, clickEars(pet)]);
      await expect(pet.locator('body')).toHaveAttribute('data-docked', '');
      await expect.poll(() => pet.locator('body').getAttribute('data-motion')).toBeNull();
      await pet.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const renderer = await pet.evaluate(() => {
        window.restoreDiagnostic.records.push(window.restoreSnapshot('completed'));
        window.restoreDiagnostic.active = false; return window.restoreDiagnostic;
      });
      const native = await app.evaluate(({ BrowserWindow }) => {
        globalThis.restoreNative.active = false;
        return { ...globalThis.restoreNative,
          panelVisible: BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible() };
      });
      const captures = [];
      for (const frame of frames) {
        const file = path.join(output, `pet-restore-${edge}-${String(frame.index).padStart(2, '0')}.png`);
        await writeFile(file, Buffer.from(frame.png, 'base64'));
        const { png, ...metadata } = frame; captures.push({ ...metadata, path: file });
      }
      const reportPath = path.join(output, `pet-restore-${edge}.json`);
      const { png, ...baselineMetadata } = baseline;
      await writeFile(reportPath, JSON.stringify({ edge, dockedBounds, ears, stableViewport,
        coordinateNote: 'Renderer screen rectangles use Chromium screenX/screenY + CSS client rects. Native bounds are Electron DIP; timestamps link both logs. capturePage shows the rendered pet window, not a physical desktop/DWM recording. PNG sizes are captured pixel dimensions, not a claimed FPS.',
        baseline: { ...baselineMetadata, path: baselinePath }, renderer, native, captures }, null, 2));
      console.log(JSON.stringify({ edge, reportPath, captureCount: captures.length + 1,
        rafSamples: renderer.records.filter(record => record.phase === 'raf').length,
        nativeBoundsEvents: native.records.length, distinctPixelHashes: new Set(captures.map(frame => frame.hash)).size }));
      expect(native.panelVisible, 'Restoring by clicking the ears must not open chat').toBe(false);
      assertRestoreContinuity({ edge, dockedBounds, stableViewport, renderer, native });
    }
  } finally { await app.close(); }
});

test('reduced-motion ear restoration completes the renderer handshake without waiting for fallback', async () => {
  const profile = await mkdtemp(path.resolve('.local/pet-restore-reduced-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    await expect.poll(() => app.windows().some(page => page.url().endsWith('/pet.html'))).toBe(true);
    const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
    await expect(pet.locator('#petState')).toHaveText('点我提问');
    await pet.emulateMedia({ reducedMotion: 'reduce' });
    await installDiagnostics(app, pet);
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const { bounds: dockedBounds, ears, stableViewport } = await dockAt(app, pet, edge);
      await prepareNearbyForehead(app, pet, edge, ears);
      await app.evaluate((_electron, edge) => { globalThis.restoreNative = { active: true, edge, records: [] }; }, edge);
      await pet.evaluate(edge => {
        window.restoreDiagnostic = { active: true, edge, records: [] };
        window.restoreDiagnostic.records.push(window.restoreSnapshot('before-click'));
      }, edge);
      await clickEars(pet);
      // The host fallback takes 2280ms; successful settlement must occur before it.
      await expect.poll(() => pet.locator('body').getAttribute('data-motion-phase'), { timeout: 1500 }).toBeNull();
      await expect(pet.locator('body')).toHaveAttribute('data-docked', '');
      await pet.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const renderer = await pet.evaluate(() => {
        window.restoreDiagnostic.records.push(window.restoreSnapshot('completed'));
        window.restoreDiagnostic.active = false; return window.restoreDiagnostic;
      });
      const native = await app.evaluate(({ BrowserWindow }) => {
        globalThis.restoreNative.active = false;
        return { ...globalThis.restoreNative,
          panelVisible: BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible() };
      });
      expect(native.panelVisible).toBe(false);
      assertRestoreContinuity({ edge, dockedBounds, stableViewport, renderer, native, reducedMotion: true });
    }
  } finally { await app.close(); }
});
