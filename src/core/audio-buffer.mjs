// A sample-based ring: retention follows captured audio, not timer callbacks.
export class AudioRing {
  constructor(sampleRate, seconds = 120) {
    this.sampleRate = sampleRate;
    this.buffer = new Float32Array(Math.ceil(sampleRate * seconds));
    this.total = 0;
  }
  append(channels) {
    if (!channels.length) return;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      this.buffer[this.total++ % this.buffer.length] = value / channels.length;
    }
  }
  snapshot() {
    const count = Math.min(this.total, this.buffer.length), samples = new Float32Array(count);
    const start = this.total - count;
    for (let i = 0; i < count; i++) samples[i] = this.buffer[(start + i) % this.buffer.length];
    return { samples, sampleRate: this.sampleRate, total: this.total };
  }
}

// Absolute sample positions belong to one live AudioRing, not the course clock.
// Callers own acknowledgement/preparation cursors; slicing never advances either.
export function sliceUntranscribedAudio(snapshot, afterTotal = 0) {
  if (!snapshot || !(snapshot.samples instanceof Float32Array)
      || !Number.isSafeInteger(snapshot.sampleRate) || snapshot.sampleRate <= 0
      || !Number.isSafeInteger(snapshot.total) || snapshot.total < snapshot.samples.length) {
    throw new Error('音频快照格式无效');
  }
  if (!Number.isSafeInteger(afterTotal) || afterTotal < 0 || afterTotal > snapshot.total) {
    throw new Error('音频进度与当前录音不一致，请重新选择课程窗口');
  }
  const retainedStartTotal = snapshot.total - snapshot.samples.length;
  const startTotal = Math.max(retainedStartTotal, afterTotal);
  const missingSamples = Math.max(0, retainedStartTotal - afterTotal);
  return {
    samples: snapshot.samples.slice(startTotal - retainedStartTotal),
    sampleRate: snapshot.sampleRate,
    total: snapshot.total,
    startTotal,
    endTotal: snapshot.total,
    retainedStartTotal,
    missingSamples,
    missingSeconds: missingSamples / snapshot.sampleRate,
  };
}

export function encodeWav({ samples, sampleRate }) {
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
