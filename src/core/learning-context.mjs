// Persist lecture text, but send a bounded selection instead of the whole archive.
export function selectTranscripts(transcripts, question, end, limit = 12) {
  const eligible = transcripts.filter(t => t.end <= end + 1);
  const tokens = question.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/g) ?? [];
  const recent = eligible.slice(-6);
  const older = eligible.slice(0, -6).map(t => ({ t, score: tokens.filter(token => t.text.toLowerCase().includes(token)).length }))
    .filter(row => row.score).sort((a, b) => b.score - a.score).slice(0, limit - recent.length).map(row => row.t);
  return [...older, ...recent].sort((a, b) => a.start - b.start);
}

// Compare with the last sampled image, so queued frames keep the same change gate.
export class CaptureGate {
  constructor({ interval = 30, threshold = 0.002 } = {}) { this.interval = interval; this.threshold = threshold; this.reset(); }
  reset() { this.last = -Infinity; this.reference = null; }
  shouldRead(time, pixels, difference, { force = false } = {}) {
    if (!force && time - this.last < this.interval) return false;
    if (!force && this.reference && difference(this.reference, pixels) <= this.threshold) return false;
    this.last = time; this.reference = new Uint8ClampedArray(pixels); return true;
  }
}
