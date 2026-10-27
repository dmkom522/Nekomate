import { translate, normalizeLanguage } from '../core/i18n.mjs';

const button = document.getElementById('petButton');
let language = 'zh-CN', labelState = { status: 'idle', capturing: false, docked: '' };
let pointer, dragged = false, moving = false;
const cat = document.querySelector('.cat-art'), peek = document.querySelector('.dock-peek'), head = document.querySelector('.dock-head');
let motionId = null, animations = [], activeMotion = null;
const phases = { prepare: 0, play: 1, settle: 2 };
function clearMotionDrawing() {
  animations.forEach(animation => animation.cancel()); animations = [];
  delete document.body.dataset.motion;
  for (const element of [cat, peek]) for (const key of ['left', 'top', 'transform', 'opacity']) element.style[key] = '';
  head.style.transform = ''; head.style.transition = '';
}
function clearMotion() {
  activeMotion = null; motionId = null;
  clearMotionDrawing(); delete document.body.dataset.motionPhase;
}
function currentMotion(active, phase) { return activeMotion === active && motionId === active.id && active.phase === phase; }
function afterTwoFrames(active, phase, callback) {
  requestAnimationFrame(() => {
    if (!currentMotion(active, phase)) return;
    requestAnimationFrame(() => { if (currentMotion(active, phase)) callback(); });
  });
}
function acknowledgeMotion(active, phase, action) {
  if (!currentMotion(active, phase) || active.sent.has(action)) return;
  active.sent.add(action);
  window.pet.action(action, active.id).catch(() => {});
}
function whenViewportMatches(active, phase, callback) {
  const check = () => {
    if (!currentMotion(active, phase)) return;
    const viewport = active.viewport;
    if (viewport && Math.abs(window.innerWidth - viewport.width) <= 1 && Math.abs(window.innerHeight - viewport.height) <= 1
      && (!active.stableViewport || (Math.abs(window.screenX - viewport.x) <= 1 && Math.abs(window.screenY - viewport.y) <= 1))) callback();
    else requestAnimationFrame(check);
  };
  check();
}
function motionAnchor(position, whole, origin, size) {
  const local = position - origin;
  const factor = whole === size ? 0 : origin / (whole - size);
  return `calc(${factor * 100}% + ${local - factor * size}px)`;
}
function prepareMotion(motion, headTransform) {
  clearMotion(); motionId = motion.id;
  const active = { id: motion.id, kind: motion.kind, edge: motion.edge, phase: null,
    viewport: motion.viewport, duration: motion.duration, stableViewport: motion.stableViewport, started: new Set(), sent: new Set(), drawingSettled: false };
  activeMotion = active;
  document.body.dataset.motion = motion.kind;
  // Freeze before the incoming peeking=false or the motion selectors can retract the forehead.
  head.style.transition = 'none';
  head.style.transform = motion.kind === 'restoring' ? headTransform : 'translateY(26px)';
  const { edge, scene } = motion, docking = motion.kind === 'docking';
  // The visible drawing keeps its screen coordinates in both its native viewport and the union.
  // Its other endpoint is transparent, so each drawing uses its own natural viewport as reference.
  const catViewport = docking ? scene.start : scene.expanded;
  const peekViewport = docking ? scene.peek : scene.start;
  const catX = scene.expanded.x + (scene.expanded.width - 120) / 2;
  cat.style.left = motionAnchor(catX, scene.bounds.width, catViewport.x, catViewport.width);
  cat.style.top = motionAnchor(scene.expanded.y, scene.bounds.height, catViewport.y, catViewport.height);
  peek.style.left = motionAnchor(scene.peek.x + scene.peek.width / 2, scene.bounds.width, peekViewport.x, peekViewport.width);
  peek.style.top = motionAnchor(scene.peek.y + scene.peek.height / 2, scene.bounds.height, peekViewport.y, peekViewport.height);
  const angle = ({ left: 90, right: -90, top: 180, bottom: 0 })[edge];
  const rotation = `translate(-50%, -50%) rotate(${angle}deg)`;
  peek.style.transform = rotation;
  const dx = edge === 'left' ? -144 : edge === 'right' ? 144 : 0;
  const dy = edge === 'top' ? -136 : edge === 'bottom' ? 136 : 0;
  const catFrames = [{ opacity: 1, transform: 'translate(0, 0)' }, { opacity: 0, transform: `translate(${dx}px, ${dy}px)` }];
  const peekFrames = [
    { opacity: 0, transform: `${rotation} scale(.8)`, offset: 0 },
    { opacity: 0, transform: `${rotation} scale(.8)`, offset: .3 },
    { opacity: 1, transform: `${rotation} scale(1)`, offset: 1 },
  ];
  if (!docking) {
    catFrames.reverse();
    peekFrames.reverse().forEach(frame => { frame.offset = 1 - frame.offset; });
  }
  // Reposition the docked native window only after the cat is transparent.
  // Its ears appear after settlement, then restoration never resizes it.
  if (motion.stableViewport && docking) for (const frame of peekFrames) frame.opacity = 0;
  // A paused positive duration retains the first keyframe even for reduced-motion users.
  // The requested zero duration is applied only once the resized viewport is ready to play.
  const options = { duration: Math.max(1, motion.duration), easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' };
  animations = [cat.animate(catFrames, options), peek.animate(peekFrames, options)];
  for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
  return active;
}
function updateMotion(motion, headTransform) {
  const phase = motion.phase;
  if (!Object.hasOwn(phases, phase)) return;
  const active = motionId === motion.id ? activeMotion : prepareMotion(motion, headTransform);
  if (active.phase !== null && phases[phase] < phases[active.phase]) return;
  active.phase = phase; active.viewport = motion.viewport; active.duration = motion.duration;
  document.body.dataset.motionPhase = phase;
  if (active.started.has(phase)) return;
  active.started.add(phase);
  if (phase === 'prepare') {
    afterTwoFrames(active, phase, () => acknowledgeMotion(active, phase, 'motion-ready'));
  } else if (phase === 'play') {
    whenViewportMatches(active, phase, () => {
      const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : active.duration;
      for (const animation of animations) { animation.effect.updateTiming({ duration }); animation.play(); }
      Promise.all(animations.map(animation => animation.finished)).then(() => {
        if (!currentMotion(active, phase)) return;
        afterTwoFrames(active, phase, () => acknowledgeMotion(active, phase, 'motion-end'));
      }).catch(() => {});
    });
  } else {
    whenViewportMatches(active, phase, () => {
      document.body.dataset.docked = active.kind === 'docking' ? active.edge : '';
      clearMotionDrawing(); active.drawingSettled = true;
      // Retain the motion ID until the host completes settlement; pointer input stays blocked.
      const acknowledge = () => afterTwoFrames(active, phase, () => acknowledgeMotion(active, phase, 'motion-settled'));
      if (active.stableViewport && active.kind === 'docking') {
        const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 90;
        const reveal = peek.animate([{ opacity: 0 }, { opacity: 1 }], { duration, fill: 'both', easing: 'ease-out' });
        animations.push(reveal);
        reveal.finished.then(() => { if (currentMotion(active, phase)) acknowledge(); }).catch(() => {});
      } else acknowledge();
    });
  }
}
function renderLabels() {
  const { status, capturing, docked } = labelState;
  const text = value => translate(value, language);
  document.documentElement.lang = language;
  document.title = text('Nekomate 桌宠');
  const label = text(docked ? '叫回小猫' : '打开或收起问答');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.setAttribute('aria-description', text('拖动换位置，拖出屏幕边缘后松手收起，右键打开菜单'));
  document.getElementById('petState').textContent = text(({ thinking: '正在想…', answered: '回答好了', error: '点我查看问题' })[status] ?? (capturing ? '正在认真听讲' : '点我提问'));
}
function changeLanguage(value) {
  language = normalizeLanguage(value?.language ?? value);
  // Updating text does not restart docking motion or change the current pet state.
  renderLabels();
}
function render({ status = 'idle', capturing = false, docked = '', peeking = false, dockLayout = null, motion = null, language: nextLanguage = language } = {}) {
  language = normalizeLanguage(nextLanguage);
  labelState = { status, capturing, docked };
  const previousDocked = document.body.dataset.docked, wasAnimating = motionId !== null;
  const headTransform = motion && motion.id !== motionId ? getComputedStyle(head).transform : null;
  document.body.dataset.status = status;
  document.body.dataset.capturing = String(capturing);
  document.body.dataset.docked = motion?.id === motionId && activeMotion?.drawingSettled
    ? activeMotion.kind === 'docking' ? activeMotion.edge : '' : docked;
  document.body.dataset.peeking = String(peeking);
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    if (dockLayout) document.body.style.setProperty(`--dock-${axis}`, `${dockLayout[axis] + dockLayout[size] / 2}px`);
    else document.body.style.removeProperty(`--dock-${axis}`);
  }
  if (motion) updateMotion(motion, headTransform);
  else {
    clearMotion();
    if (previousDocked && !docked && !wasAnimating && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      cat.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
  }
  renderLabels();
}
window.pet.onState(render);
window.pet.onLanguageChanged(changeLanguage);
window.pet.action('state').then(render);
button.onpointerdown = event => {
  if (event.button !== 0 || motionId !== null) return;
  pointer = { x: event.screenX, y: event.screenY }; dragged = false;
  button.setPointerCapture(event.pointerId); window.pet.action('drag-start');
};
button.onpointermove = async event => {
  if (!pointer || moving) return;
  if (Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) < 5 && !dragged) return;
  dragged = true; moving = true;
  try { await window.pet.action('drag-move'); } finally { moving = false; }
};
button.onpointerup = async event => {
  if (!pointer) return;
  const toggle = !dragged; pointer = null;
  button.releasePointerCapture(event.pointerId);
  await window.pet.action('drag-end');
  if (toggle) await window.pet.action('toggle');
};
button.onpointercancel = () => { pointer = null; window.pet.action('drag-end'); };
button.onclick = event => { if (event.detail === 0) window.pet.action('toggle'); };
document.oncontextmenu = event => { event.preventDefault(); window.pet.action('menu'); };
