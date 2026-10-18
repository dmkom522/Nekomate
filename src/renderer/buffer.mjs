export const BUFFER_LIMITS = { maxFrames: 600, maxBytes: 48 * 1024 * 1024, maxAge: 20 * 60 };

export function formatTime(value) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export class FrameBuffer {
  constructor(limits = BUFFER_LIMITS) { this.limits = limits; this.frames = []; this.bytes = 0; this.evicted = 0; }
  add(frame) {
    this.frames.push(frame);
    this.bytes += frame.image.length * 2;
    while (this.frames.length > 1 && (this.frames.length > this.limits.maxFrames || this.bytes > this.limits.maxBytes || frame.time - this.frames[0].time > this.limits.maxAge)) {
      this.bytes -= this.frames.shift().image.length * 2;
      this.evicted++;
    }
  }
  select(start, end, count = 8) {
    return selectEvenly(this.frames.filter(frame => frame.time >= start && frame.time <= end), count);
  }
}

export function selectEvenly(items, count) {
  if (count < 1 || !items.length) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items.at(-1)];
  return Array.from({ length: count }, (_, i) => items[Math.round(i * (items.length - 1) / (count - 1))]);
}

export function pixelChange(previous, current) {
  if (!previous || previous.length !== current.length) return 1;
  let changed = 0;
  for (let i = 0; i < current.length; i += 4) {
    const delta = Math.abs(current[i] - previous[i]) + Math.abs(current[i + 1] - previous[i + 1]) + Math.abs(current[i + 2] - previous[i + 2]);
    if (delta > 45) changed++;
  }
  return changed / (current.length / 4);
}

export function validateSession(input) {
  if (input?.format !== 'deskmate-session' || input.version !== 1) throw new Error('不是兼容的 Deskmate 记录文件');
  if (!Array.isArray(input.frames) || input.frames.length > 600 || !Array.isArray(input.transcripts) || input.transcripts.length > 2000 || !Array.isArray(input.messages) || input.messages.length > 300) throw new Error('记录文件结构不正确或超过容量限制');
  for (const f of input.frames) if (!Number.isFinite(f.time) || f.time < 0 || typeof f.image !== 'string' || f.image.length > 3_000_000 || !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/]+=*$/.test(f.image)) throw new Error('记录中的画面无效');
  for (const t of input.transcripts) if (!Number.isFinite(t.start) || !Number.isFinite(t.end) || t.start < 0 || t.end < t.start || typeof t.text !== 'string' || t.text.length > 8000) throw new Error('记录中的转写无效');
  for (const m of input.messages) {
    if (!['user', 'assistant', 'error'].includes(m.role) || typeof m.text !== 'string' || m.text.length > 64000) throw new Error('记录中的对话无效');
    if (m.sources !== undefined) {
      if (!Array.isArray(m.sources) || m.sources.length > 132) throw new Error('记录中的来源无效');
      for (const s of m.sources) {
        if (!s || !/^[FT]\d+$/.test(s.id) || !['frame', 'transcript'].includes(s.type)) throw new Error('记录中的来源无效');
        if (s.type === 'frame' && (!Number.isFinite(s.time) || s.time < 0)) throw new Error('画面来源时间无效');
        if (s.type === 'transcript' && (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end < s.start || typeof s.text !== 'string' || s.text.length > 8000)) throw new Error('讲解来源无效');
      }
    }
  }
  return input;
}
