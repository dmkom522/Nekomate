// Only text and the attempt flag are persisted. Initial samples stay in memory.
export function validateCourseContext(value) {
  if (value === undefined) return { text: '', attempted: false };
  if (!value || typeof value.text !== 'string' || value.text.length > 6000 || typeof value.attempted !== 'boolean') throw new Error('课程背景记录无效');
  return { text: value.text, attempted: value.attempted || Boolean(value.text) };
}

export class CourseContext {
  constructor({ identify, cancel, onUpdate = () => {} }) {
    this.identify = identify; this.cancel = cancel; this.onUpdate = onUpdate;
    this.epoch = 0; this.restore();
  }
  get text() { return this.saved.text; }
  serialize() { return { ...this.saved }; }
  restore(value) {
    const saved = validateCourseContext(value);
    this.interrupt(); this.saved = saved; this.frames = []; this.source = '';
  }
  interrupt() {
    this.epoch++;
    if (this.pending) this.cancel(this.pending.id);
    this.pending = null;
  }
  collect(frame, source) {
    if (this.saved.attempted) return;
    if (source !== this.source) { this.frames = []; this.source = source; }
    if (this.frames.some(item => item.image === frame.image)) return;
    this.frames.push({ image: frame.image, time: frame.time, ...(frame.eventId ? { eventId: frame.eventId } : {}) });
    if (this.frames.length >= 3) void this.resolve();
  }
  tick(time) {
    // A stationary slide may supply fewer than three distinct samples.
    if (this.frames.length && time - this.frames[0].time >= 30) void this.resolve();
  }
  async resolve() {
    if (this.saved.attempted || !this.frames.length) return;
    const id = crypto.randomUUID(), epoch = this.epoch;
    const input = { frames: this.frames, source: this.source };
    this.frames = []; this.saved.attempted = true;
    this.pending = { id }; this.onUpdate();
    try {
      const result = await this.identify(id, input);
      if (epoch !== this.epoch) return;
      const saved = validateCourseContext({ text: result.text, attempted: true });
      this.saved = saved;
    } catch {
      // Failed/cancelled discovery does not block learning or retry on every slide.
    } finally {
      if (epoch === this.epoch) { this.pending = null; this.onUpdate(); }
    }
  }
}
