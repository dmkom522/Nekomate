import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PET_SIZE, DOCK_MOTION_MS, dockAtEdge, dockScene } from '../src/core/pet-dock.mjs';
import { normalizeLanguage } from '../src/core/i18n.mjs';

// Exercise the production main-process functions without starting Electron or copying their logic.
const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'Production motion functions must remain discoverable');
  return source.slice(from, to);
};
const functions = between('function currentPetState()', 'function petMenu()');
const clamp = between('function clampToDisplay(', 'function positionPanel()');
const fit = between('  const fitPet = () => {', "  screen.on('display-removed', fitPet)");
const createMotion = new Function('dependencies', `
  const { PET_SIZE, DOCK_MOTION_MS, dockAtEdge, dockScene, screen, petWindow, mainWindow, setTimeout, clearTimeout, process, normalizeLanguage } = dependencies;
  const config = { language: 'zh-CN' };
  let petStatus='idle',captureActive=false,petDock=null,petPeeking=false,petMotion=null,petMotionSerial=0;
  ${clamp}
  ${functions}
  ${fit}
  return { animatePet,startPetMotion,settlePetMotion,completePetMotion,finishPetMotion,restorePet,fitPet,
    state:currentPetState,seedDock:dock=>{petDock=dock;},peek:()=>{petPeeking=true;} };
`);

function fixture({ area = { x: 0, y: 0, width: 800, height: 600 }, initial = { ...PET_SIZE, x: -40, y: 200 }, rounding = false, nativeShape = false } = {}) {
  let bounds = { ...initial }, serial = 0;
  const events = [], timers = new Map();
  const window = {
    getBounds: () => ({ ...bounds }),
    setBounds: value => {
      bounds = { ...value };
      if (rounding && value.width === 40 && value.height === 80) { bounds.width++; bounds.height++; }
      events.push({ type: 'bounds', value: { ...bounds } });
    },
    webContents: { send: (_channel, state) => events.push({ type: 'state', value: structuredClone(state) }) },
  };
  if (nativeShape) window.setShape = rects => events.push({ type: 'shape', value: structuredClone(rects) });
  const motion = createMotion({ PET_SIZE, DOCK_MOTION_MS, dockAtEdge, dockScene, normalizeLanguage,
    process: { platform: 'win32' },
    petWindow: window, mainWindow: { hide: () => events.push({ type: 'hide' }) },
    screen: { getDisplayMatching: () => ({ id: 1, bounds: area, workArea: area }), getAllDisplays: () => [{ id: 1, bounds: area }] },
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { ...motion, area, events, timers, window,
    dock: dockAtEdge(initial, area),
    bounds: () => ({ ...bounds }),
    timeout: () => { assert.equal(timers.size, 1); [...timers.values()][0].callback(); },
  };
}

test('native resize waits for renderer readiness and promises wait for the settled acknowledgement', async () => {
  const value = fixture(), before = value.bounds();
  const finished = value.animatePet('docking', value.dock, before);
  let resolved = false; finished.then(() => { resolved = true; });
  const id = value.state().motion.id;
  assert.deepEqual(value.bounds(), before);
  assert.deepEqual(value.events.map(event => event.type), ['state']);
  assert.equal(value.state().motion.phase, 'prepare');
  value.settlePetMotion(id); value.completePetMotion(id); value.startPetMotion(id + 1);
  assert.deepEqual(value.bounds(), before, 'out-of-phase and stale acknowledgements cannot resize');
  value.startPetMotion(id);
  assert.equal(value.state().motion.phase, 'play');
  assert.deepEqual(value.events.slice(-2).map(event => event.type), ['bounds', 'state']);
  assert.deepEqual(value.state().motion.viewport, value.bounds());
  const count = value.events.length;
  value.startPetMotion(id); value.completePetMotion(id);
  assert.equal(value.events.length, count);
  value.settlePetMotion(id);
  assert.equal(value.state().motion.phase, 'settle');
  assert.deepEqual(value.bounds(), value.dock.bounds);
  await Promise.resolve(); assert.equal(resolved, false);
  value.completePetMotion(id);
  await finished;
  assert.equal(value.state().motion, null); assert.equal(resolved, true); assert.equal(value.timers.size, 0);
});

for (const [edge, position] of Object.entries({ left: { x: -40, y: 200 }, right: { x: 720, y: 200 }, top: { x: 200, y: -40 }, bottom: { x: 200, y: 530 } })) {
  test(`Windows ${edge} restoration retains its native surface through every phase`, async () => {
    const value = fixture({ nativeShape: true, initial: { ...PET_SIZE, ...position } });
    const docking = value.animatePet('docking', value.dock, value.bounds()), id = value.state().motion.id;
    value.startPetMotion(id);
    assert.equal(value.events.filter(event => event.type === 'bounds').length, 0, 'docking does not resize its drawing surface');
    value.settlePetMotion(id); value.completePetMotion(id); await docking;
    const bounds = value.bounds(), layout = value.state().dockLayout;
    assert.equal(bounds.width, PET_SIZE.width); assert.equal(bounds.height, PET_SIZE.height);
    assert.deepEqual({ ...layout, x: layout.x + bounds.x, y: layout.y + bounds.y }, value.dock.bounds);
    assert.deepEqual(value.events.findLast(event => event.type === 'shape').value, [layout]);
    value.events.length = 0; value.peek();
    const restored = value.restorePet(), restoreId = value.state().motion.id;
    for (const transition of [() => {}, value.startPetMotion, value.settlePetMotion, value.completePetMotion]) {
      transition(restoreId);
      assert.deepEqual(value.bounds(), bounds);
      assert.equal(value.events.filter(event => event.type === 'bounds').length, 0, 'click restoration never moves or resizes the native surface');
    }
    await restored;
    assert.deepEqual(value.events.findLast(event => event.type === 'shape').value, []);
    assert.equal(value.state().docked, ''); assert.equal(value.state().dockLayout, null);
  });
}

test('Windows timeout and immediate restore both clear the native ear region', async () => {
  for (const immediate of [false, true]) {
    const value = fixture({ nativeShape: true });
    const docking = value.animatePet('docking', value.dock, value.bounds()); value.timeout(); await docking;
    assert.equal(value.events.findLast(event => event.type === 'shape').value.length, 1);
    const restoring = value.restorePet(!immediate);
    if (!immediate) value.timeout();
    await restoring;
    assert.deepEqual(value.events.findLast(event => event.type === 'shape').value, []);
    assert.equal(value.state().motion, null); assert.equal(value.state().docked, '');
  }
});

test('restoring preserves the ear viewport until ready and supplies both local coordinate anchors', async () => {
  const expanded = { ...PET_SIZE, x: -40, y: 200 }, area = { x: 0, y: 0, width: 800, height: 600 };
  const dock = dockAtEdge(expanded, area), value = fixture({ area, initial: dock.bounds });
  value.seedDock(dock); value.peek();
  const finished = value.restorePet(), motion = value.state().motion;
  assert.equal(motion.kind, 'restoring'); assert.equal(motion.phase, 'prepare');
  assert.deepEqual(value.bounds(), dock.bounds, 'ready must precede expansion of the native ear window');
  assert.equal(motion.scene.bounds.x + motion.scene.start.x, dock.bounds.x);
  assert.equal(motion.scene.bounds.y + motion.scene.start.y, dock.bounds.y);
  assert.equal(motion.scene.start.width, dock.bounds.width);
  assert.equal(motion.scene.expanded.width, PET_SIZE.width);
  value.startPetMotion(motion.id); value.settlePetMotion(motion.id);
  assert.equal(value.state().docked, '');
  value.completePetMotion(motion.id); await finished;
  assert.deepEqual(value.bounds(), { ...PET_SIZE, x: 0, y: 200 });
});

for (const phase of ['prepare', 'play', 'settle']) {
  test(`a renderer stalled in ${phase} reaches a bounded final state and ignores late acknowledgements`, async () => {
    const value = fixture(), finished = value.animatePet('docking', value.dock, value.bounds()), id = value.state().motion.id;
    if (phase !== 'prepare') value.startPetMotion(id);
    if (phase === 'settle') value.settlePetMotion(id);
    assert.ok([...value.timers.values()][0].delay > DOCK_MOTION_MS);
    value.timeout(); await finished;
    assert.equal(value.state().motion, null); assert.equal(value.state().docked, 'left');
    assert.deepEqual(value.bounds(), value.dock.bounds);
    const count = value.events.length;
    value.startPetMotion(id); value.settlePetMotion(id); value.completePetMotion(id); value.finishPetMotion(id);
    assert.equal(value.events.length, count); assert.equal(value.timers.size, 0);
  });
}

test('a newer restore invalidates callbacks and deadlines from an interrupted docking motion', async () => {
  const value = fixture(), docking = value.animatePet('docking', value.dock, value.bounds());
  const oldId = value.state().motion.id, oldTimeout = [...value.timers.values()][0].callback;
  value.startPetMotion(oldId);
  const restoring = value.restorePet(), newId = value.state().motion.id;
  await docking;
  assert.notEqual(newId, oldId); assert.equal(value.state().motion.kind, 'restoring');
  const before = structuredClone(value.state()), bounds = value.bounds();
  oldTimeout(); value.startPetMotion(oldId); value.settlePetMotion(oldId); value.completePetMotion(oldId);
  assert.deepEqual(value.state(), before); assert.deepEqual(value.bounds(), bounds);
  value.startPetMotion(newId); value.settlePetMotion(newId); value.completePetMotion(newId);
  await restoring; assert.equal(value.state().docked, '');
});

test('settle reports actual rounded bounds and corrects right-edge overflow before acknowledging completion', async () => {
  const value = fixture({ area: { x: -800, y: 0, width: 800, height: 600 }, initial: { ...PET_SIZE, x: -80, y: 200 }, rounding: true });
  const finished = value.animatePet('docking', value.dock, value.bounds()), id = value.state().motion.id;
  value.startPetMotion(id); value.settlePetMotion(id);
  const bounds = value.bounds();
  assert.equal(bounds.width, 41); assert.equal(bounds.height, 81);
  assert.equal(bounds.x + bounds.width, 0);
  assert.deepEqual(value.state().motion.viewport, bounds);
  value.completePetMotion(id); await finished;
});

test('display fitting interrupts the old handshake and creates a separately acknowledged replacement dock', async () => {
  const value = fixture(), previous = value.animatePet('docking', value.dock, value.bounds()), oldId = value.state().motion.id;
  value.startPetMotion(oldId); value.fitPet(); await previous;
  const current = value.state().motion;
  assert.ok(current && current.id !== oldId); assert.equal(current.phase, 'prepare');
  value.completePetMotion(oldId); value.settlePetMotion(oldId);
  assert.equal(value.state().motion.id, current.id);
  value.startPetMotion(current.id); value.settlePetMotion(current.id); value.completePetMotion(current.id);
  assert.equal(value.state().motion, null); assert.equal(value.state().docked, 'left');
});
