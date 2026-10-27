import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export async function petGeometry(app) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    const state = await pet.webContents.executeJavaScript('window.pet.action("state")');
    const bounds = pet.getBounds(), layout = state.dockLayout;
    return { bounds, stableViewport: Boolean(layout), ears: layout ? { ...layout, x: bounds.x + layout.x, y: bounds.y + layout.y } : bounds };
  });
}

// Click the visible ear drawing, rather than the centre of the larger transparent surface.
export async function clickEars(pet) {
  const rect = await pet.locator('.dock-peek').boundingBox();
  if (!rect) throw new Error('The docked ears are not visible');
  await pet.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}
export async function probePetRegion(app, geometry) {
  const handle = await app.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/pet.html'));
    return pet.getNativeWindowHandle().readBigUInt64LE().toString();
  });
  const { bounds, ears } = geometry;
  const points = [
    { name: 'ears', x: ears.x - bounds.x + ears.width / 2, y: ears.y - bounds.y + ears.height / 2 },
    { name: 'unused', x: bounds.width / 2, y: bounds.height / 2 },
  ];
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-File',
    fileURLToPath(new URL('../fixtures/window-region.ps1', import.meta.url)), handle, JSON.stringify(points)],
  { windowsHide: true, timeout: 15000 });
  return JSON.parse(stdout);
}
