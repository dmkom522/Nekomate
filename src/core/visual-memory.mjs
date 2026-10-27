export function validateNotes(notes = [], limit = Infinity) {
  if (!Array.isArray(notes) || notes.length > limit) throw new Error('画面理解记录过多');
  return notes.map(note => {
    if (!note || !Number.isFinite(note.time) || note.time < 0 || typeof note.text !== 'string' || !note.text.trim() || note.text.length > 4000 || typeof note.source !== 'string' || note.source.length > 500) throw new Error('画面理解记录格式不正确');
    return { time: note.time, text: note.text, source: note.source };
  });
}

// Keep sampled images until their notes finish; the active image stays at the head.
export class VisualFrameQueue {
  constructor({ maxFrames = 120, maxBytes = 48 * 1024 * 1024, onFull = () => {} } = {}) {
    Object.assign(this, { maxFrames, maxBytes, onFull }); this.clear();
  }
  get full() { return this.frames.length >= this.maxFrames || this.bytes >= this.maxBytes; }
  enqueue(frame, source) {
    const bytes = frame.image.length * 2;
    if (this.full || this.bytes + bytes > this.maxBytes) {
      if (!this.warned) { this.warned = true; this.onFull(); }
      return false;
    }
    this.frames.push({ frame, source, bytes }); this.bytes += bytes; return true;
  }
  peek() { return this.frames[0]; }
  complete(entry) {
    if (this.peek() !== entry) return;
    this.frames.shift(); this.bytes -= entry.bytes; this.warned = false;
  }
  clear() { this.frames = []; this.bytes = 0; this.warned = false; }
}

// Only one model read runs at a time; the renderer owns its bounded FIFO.
export class VisualMemory {
  constructor({ analyze, cancel, onUpdate = () => {}, onError = () => {} }) {
    Object.assign(this, { analyze, cancel, onUpdate, onError });
    this.notes = []; this.pending = null; this.epoch = 0; this.failed = false; this.lastError = '';
  }
  get ready() { return !this.pending && !this.failed; }
  submit(frame, source) {
    if (!this.ready) return false;
    const epoch = this.epoch, id = crypto.randomUUID();
    const job = { id, done: null }; this.pending = job;
    job.done = (async () => {
      try {
        const result = await this.analyze(id, { frame: { image: frame.image, time: frame.time }, source, previous: this.notes.filter(n => n.source === source).slice(-2) });
        if (epoch !== this.epoch) return;
        const [note] = validateNotes([{ time: frame.time, text: result.text, source }]);
        this.notes.push(note);
        this.onUpdate();
        return note;
      } catch (error) {
        if (epoch === this.epoch) { this.failed = true; this.lastError = error.message || '画面读取失败'; this.onError(error); }
      } finally { if (this.pending === job) this.pending = null; }
    })();
    return true;
  }
  interrupt() {
    this.epoch++;
    const job = this.pending; this.pending = null;
    if (job) Promise.resolve(this.cancel(job.id)).catch(() => {});
  }
  retry() { this.failed = false; this.lastError = ''; }
  reset(notes = []) { this.interrupt(); this.notes = validateNotes(notes); this.retry(); }
  select(question, end) {
    const eligible = this.notes.filter(n => n.time <= end);
    const recent = eligible.filter(n => end - n.time <= 1200);
    // A paused/static slide remains the last observation even after the recall window elapses.
    if (!recent.length) { const last = eligible.at(-1); if (last) recent.push(last); }
    const latest = recent.slice(-12);
    const included = new Set(latest);
    const terms = question.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? [];
    const tokens = terms.flatMap(t => /[\u4e00-\u9fff]/.test(t) ? Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2)) : [t]);
    const older = eligible.filter(note => !included.has(note)).map(note => ({ note, score: tokens.filter(t => note.text.toLowerCase().includes(t)).length })).filter(n => n.score > 0).sort((a, b) => b.score - a.score || b.note.time - a.note.time).slice(0, 6).map(n => n.note);
    return [...older, ...latest].sort((a, b) => a.time - b.time);
  }
}
