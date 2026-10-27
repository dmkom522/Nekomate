import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { petGeometry, clickEars, probePetRegion } from './pet-geometry.mjs';

async function nativeState(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    return { bounds: pet.getBounds(), area: screen.getDisplayMatching(pet.getBounds()).workArea,
      panel: BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).isVisible() };
  });
}
async function headOffset(pet) {
  return pet.locator('.dock-head').evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42);
}
async function cursorDistance(app, bounds, edge, distance) {
  const reads = await app.evaluate(({ screen }, { bounds, edge, distance }) => {
    globalThis.fixtureCursor = {
      x: edge === 'left' ? bounds.x + bounds.width + distance : edge === 'right' ? bounds.x - distance : bounds.x + bounds.width / 2,
      y: edge === 'top' ? bounds.y + bounds.height + distance : edge === 'bottom' ? bounds.y - distance : bounds.y + bounds.height / 2,
    };
    return globalThis.fixtureCursorReads;
  }, { bounds, edge, distance });
  await expect.poll(() => app.evaluate(() => globalThis.fixtureCursorReads)).toBeGreaterThan(reads);
}

test('pet docks as two ears on every edge, peeks only nearby, restores on click and can be dragged out', async () => {
  test.setTimeout(90000);
  const profile = await mkdtemp(path.resolve('.local/pet-dock-'));
  const env = { ...process.env, DESKMATE_TEST_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env, executablePath: process.env.DESKMATE_ELECTRON_PATH });
  try {
    await expect.poll(() => app.windows().some(page => page.url().endsWith('/pet.html'))).toBe(true);
    const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
    await pet.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(pet.locator('#petState')).toHaveText('点我提问');
    await expect(pet.locator('#petMenu')).toHaveCount(0);
    await expect(pet.locator('.dock-tail')).toHaveCount(0);
    await pet.screenshot({ path: '.local/pet-clean.png', omitBackground: true });
    await pet.evaluate(() => {
      window.motionSamples = [];
      const sample = time => {
        if (document.body.dataset.motionPhase) {
          const cat = getComputedStyle(document.querySelector('.cat-art')), peek = getComputedStyle(document.querySelector('.dock-peek'));
          window.motionSamples.push({ time, kind: document.body.dataset.motion, catOpacity: Number(cat.opacity), peekOpacity: Number(peek.opacity), transform: cat.transform, width: innerWidth, height: innerHeight });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    // Cursor input is controlled; polling, IPC, native window bounds and rendered pixels are real.
    await app.evaluate(({ screen }) => {
      globalThis.fixtureCursor = { x: 300, y: 300 }; globalThis.fixtureCursorReads = 0;
      screen.getCursorScreenPoint = () => { globalThis.fixtureCursorReads++; return globalThis.fixtureCursor; };
    });
    async function dock(edge, inspectPixels = false) {
      await app.evaluate(({ BrowserWindow, screen }) => {
        const area = screen.getPrimaryDisplay().workArea;
        BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).setBounds({ x: area.x + 200, y: area.y + 200, width: 126, height: 118 });
        globalThis.fixtureCursor = { x: area.x + 240, y: area.y + 240 };
      });
      await pet.evaluate(() => window.pet.action('drag-start'));
      await app.evaluate(({ screen }, edge) => {
        const area = screen.getPrimaryDisplay().bounds;
        globalThis.fixtureCursor = {
          x: edge === 'left' ? area.x : edge === 'right' ? area.x + area.width - 40 : area.x + 240,
          y: edge === 'top' ? area.y : edge === 'bottom' ? area.y + area.height - 40 : area.y + 240,
        };
      }, edge);
      await pet.evaluate(() => window.pet.action('drag-move'));
      const dragged = await app.evaluate(({ BrowserWindow, screen }) => ({ bounds: BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html')).getBounds(), screen: screen.getPrimaryDisplay().bounds }));
      if (edge === 'left') expect(dragged.bounds.x).toBeLessThan(dragged.screen.x);
      if (edge === 'right') expect(dragged.bounds.x + dragged.bounds.width).toBeGreaterThan(dragged.screen.x + dragged.screen.width);
      if (edge === 'top') expect(dragged.bounds.y).toBeLessThan(dragged.screen.y);
      if (edge === 'bottom') expect(dragged.bounds.y + dragged.bounds.height).toBeGreaterThan(dragged.screen.y + dragged.screen.height);
      await expect(pet.locator('body')).toHaveAttribute('data-docked', '');
      await pet.evaluate(() => { window.motionSamples = []; });
      const finished = pet.evaluate(() => window.pet.action('drag-end'));
      if (inspectPixels) {
        const frames = await app.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
          const { createHash } = process.getBuiltinModule('crypto'), frames = [];
          for (let index = 0; index < 8; index++) {
            const motion = await window.webContents.executeJavaScript('document.body.dataset.motion || ""');
            const image = await window.webContents.capturePage();
            frames.push({ motion, size: image.getSize(), hash: createHash('sha256').update(image.toBitmap()).digest('hex'), png: index === 3 ? image.toPNG().toString('base64') : '' });
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          return frames;
        });
        const painted = frames.filter(frame => frame.motion === 'docking' && frame.size.width >= 126 && frame.size.height >= 118);
        expect(new Set(painted.map(frame => frame.hash)).size, 'Native pixels change while the full cat window is animating').toBeGreaterThan(1);
        const preview = frames.find(frame => frame.png);
        await writeFile('.local/pet-ears-motion-' + edge + '.png', Buffer.from(preview.png, 'base64'));
      }
      await finished;
      const samples = await pet.evaluate(() => window.motionSamples);
      expect(samples.filter(sample => sample.catOpacity > .02 && sample.catOpacity < .98).length).toBeGreaterThan(3);
      expect(samples.filter(sample => sample.peekOpacity > .02 && sample.peekOpacity < .98).length).toBeGreaterThan(1);
      expect(new Set(samples.map(sample => sample.transform)).size).toBeGreaterThan(4);
      expect(samples.filter(sample => sample.catOpacity > .02).every(sample => sample.width >= 126 && sample.height >= 118)).toBe(true);
      await expect(pet.locator('body')).toHaveAttribute('data-docked', edge);
      return nativeState(app);
    }
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const actual = await dock(edge, true), vertical = edge === 'left' || edge === 'right';
      const geometry = await petGeometry(app), ears = geometry.ears;
      expect(Math.abs(ears.width - (vertical ? 40 : 80))).toBeLessThanOrEqual(1);
      expect(Math.abs(ears.height - (vertical ? 80 : 40))).toBeLessThanOrEqual(1);
      if (geometry.stableViewport) {
        expect(Math.abs(actual.bounds.width - 126)).toBeLessThanOrEqual(1);
        expect(Math.abs(actual.bounds.height - 118)).toBeLessThanOrEqual(1);
        const region = await probePetRegion(app, geometry);
        expect(region.kind, 'Windows has applied a native clipping region').toBeGreaterThan(0);
        expect(region.points.find(point => point.name === 'ears').included).toBe(true);
        const unused = region.points.find(point => point.name === 'unused');
        expect(unused.included, 'Unused transparent space is outside the actual OS region').toBe(false);
        expect(unused.hitsPet, 'Windows hit-testing does not route unused-space input to the pet').toBe(false);
      }
      expect(actual.panel).toBe(false);
      expect(actual.bounds.x).toBeGreaterThanOrEqual(actual.area.x);
      expect(actual.bounds.y).toBeGreaterThanOrEqual(actual.area.y);
      expect(actual.bounds.x + actual.bounds.width).toBeLessThanOrEqual(actual.area.x + actual.area.width);
      expect(actual.bounds.y + actual.bounds.height).toBeLessThanOrEqual(actual.area.y + actual.area.height);
      await expect(pet.locator('.cat-art')).toBeHidden(); await expect(pet.locator('.dock-peek')).toBeVisible();
      const rotation = await pet.locator('.dock-peek').evaluate(element => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform); return [matrix.a, matrix.b, matrix.c, matrix.d];
      });
      const expectedRotation = { left: [0, 1, -1, 0], right: [0, -1, 1, 0], top: [-1, 0, 0, -1], bottom: [1, 0, 0, 1] }[edge];
      rotation.forEach((value, index) => expect(value).toBeCloseTo(expectedRotation[index], 5));
      // Keep the DOM pointer outside; otherwise CSS :hover could mask a proximity-state bug.
      await pet.mouse.move(-100, -100);
      await cursorDistance(app, ears, edge, 60);
      await expect(pet.locator('body')).toHaveAttribute('data-peeking', 'false');
      await expect.poll(() => headOffset(pet)).toBeCloseTo(26, 2);
      const idle = await pet.screenshot({ path: '.local/pet-ears-' + edge + '.png', omitBackground: true });
      await cursorDistance(app, ears, edge, 17);
      await expect(pet.locator('body')).toHaveAttribute('data-peeking', 'true');
      await expect.poll(() => headOffset(pet)).toBeCloseTo(12, 2);
      const nearby = await pet.screenshot({ path: '.local/pet-ears-hover-' + edge + '.png', omitBackground: true });
      expect(nearby.equals(idle), 'The forehead is actually painted when the cursor approaches').toBe(false);
      expect(await nativeState(app)).toEqual(actual); // Hover cannot resize, restore, or open the main panel.
      await expect(pet.locator('.cat-art')).toBeHidden();
      await cursorDistance(app, ears, edge, 25);
      await expect(pet.locator('body')).toHaveAttribute('data-peeking', 'true'); // >18 stays open within 34.
      await cursorDistance(app, ears, edge, 35);
      await expect(pet.locator('body')).toHaveAttribute('data-peeking', 'false');
      await expect.poll(() => headOffset(pet)).toBeCloseTo(26, 2);
      expect((await pet.screenshot({ omitBackground: true })).equals(idle)).toBe(true);
      await cursorDistance(app, ears, edge, 25);
      await expect(pet.locator('body')).toHaveAttribute('data-peeking', 'false'); // Cannot reactivate beyond 18.
      await pet.evaluate(() => { window.motionSamples = []; });
      await clickEars(pet);
      await expect(pet.locator('body')).toHaveAttribute('data-docked', '');
      await expect(pet.locator('body')).toHaveAttribute('data-peeking', 'false');
      const restoredSamples = await pet.evaluate(() => window.motionSamples);
      expect(restoredSamples.some(sample => sample.kind === 'restoring' && sample.catOpacity > .02 && sample.catOpacity < .98)).toBe(true);
      await expect(pet.locator('.cat-art')).toBeVisible();
      const restored = await nativeState(app);
      expect(Math.abs(restored.bounds.width - 126)).toBeLessThanOrEqual(1); expect(Math.abs(restored.bounds.height - 118)).toBeLessThanOrEqual(1);
      expect(restored.panel).toBe(false);
    }
    // Dragging out by the ears restores the cat without opening the panel.
    await dock('bottom');
    await pet.evaluate(() => window.pet.action('drag-start'));
    await app.evaluate(({ screen }) => { const area = screen.getPrimaryDisplay().workArea; globalThis.fixtureCursor = { x: area.x + 400, y: area.y + 300 }; });
    await pet.evaluate(() => window.pet.action('drag-move')); await pet.evaluate(() => window.pet.action('drag-end'));
    await expect(pet.locator('body')).toHaveAttribute('data-docked', ''); await expect(pet.locator('.cat-art')).toBeVisible();
    const draggedOut = await nativeState(app); expect(draggedOut.panel).toBe(false);
    expect(Math.abs(draggedOut.bounds.width - 126)).toBeLessThanOrEqual(1); expect(Math.abs(draggedOut.bounds.height - 118)).toBeLessThanOrEqual(1);
    await pet.locator('#petButton').click();
    const page = app.windows().find(window => window.url().endsWith('/index.html'));
    await expect(page.locator('#question')).toBeFocused();
    await page.screenshot({ path: '.local/bubble-compact.png', omitBackground: true });
  } finally { await app.close(); }
});
