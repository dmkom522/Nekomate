export const PET_SIZE = { width: 126, height: 118 };
export const DOCK_SIZE = { width: 80, depth: 40 };
export const DOCK_MOTION_MS = 280;

// Both drawings retain their screen coordinates while the native window changes size.
export function dockScene(expanded, peek) {
  const x = Math.min(expanded.x, peek.x), y = Math.min(expanded.y, peek.y);
  const bounds = { x, y, width: Math.max(expanded.x + expanded.width, peek.x + peek.width) - x,
    height: Math.max(expanded.y + expanded.height, peek.y + peek.height) - y };
  return { bounds, cat: { x: expanded.x - x, y: expanded.y - y },
    peek: { x: peek.x - x, y: peek.y - y, width: peek.width, height: peek.height } };
}

export function dockProximity(bounds, point, wasPeeking = false) {
  const dx = Math.max(bounds.x - point.x, 0, point.x - bounds.x - bounds.width);
  const dy = Math.max(bounds.y - point.y, 0, point.y - bounds.y - bounds.height);
  return Math.hypot(dx, dy) <= (wasPeeking ? 34 : 18);
}

export function dockAtEdge(bounds, area, { limits = area, neighbors = [] } = {}) {
  if (area.width < 1 || area.height < 1) return null;
  const right = limits.x + limits.width, bottom = limits.y + limits.height;
  const centerX = Math.max(limits.x, Math.min(right - 1, bounds.x + bounds.width / 2));
  const centerY = Math.max(limits.y, Math.min(bottom - 1, bounds.y + bounds.height / 2));
  const candidates = [
    ['left', (limits.x - bounds.x) / bounds.width, { x: limits.x - 1, y: centerY }],
    ['right', (bounds.x + bounds.width - right) / bounds.width, { x: right, y: centerY }],
    ['top', (limits.y - bounds.y) / bounds.height, { x: centerX, y: limits.y - 1 }],
    ['bottom', (bounds.y + bounds.height - bottom) / bounds.height, { x: centerX, y: bottom }],
  ].filter(([, outside, point]) => outside >= .3 && !neighbors.some(rect => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height))
    .sort((a, b) => b[1] - a[1]);
  if (!candidates.length) return null;
  const [edge] = candidates[0];
  const vertical = edge === 'left' || edge === 'right';
  const width = Math.min(vertical ? DOCK_SIZE.depth : DOCK_SIZE.width, area.width);
  const height = Math.min(vertical ? DOCK_SIZE.width : DOCK_SIZE.depth, area.height);
  const x = edge === 'left' ? area.x : edge === 'right' ? area.x + area.width - width
    : Math.max(area.x, Math.min(bounds.x + (bounds.width - width) / 2, area.x + area.width - width));
  const y = edge === 'top' ? area.y : edge === 'bottom' ? area.y + area.height - height
    : Math.max(area.y, Math.min(bounds.y + (bounds.height - height) / 2, area.y + area.height - height));
  return { edge, bounds: { x: Math.round(x), y: Math.round(y), width, height }, expanded: bounds };
}
