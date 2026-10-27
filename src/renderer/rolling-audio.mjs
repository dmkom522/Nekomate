import { sliceUntranscribedAudio } from '../core/audio-buffer.mjs';

export class RollingAudio {
  constructor(stream) {
    this.streamId = crypto.randomUUID();
    this.closed = false;
    this.requests = new Map();
    this.serial = 0;
    this.context = new AudioContext({ sampleRate: 16000 });
    this.ready = this.start(stream);
  }
  async start(stream) {
    try {
      await this.context.audioWorklet.addModule(new URL('./audio-worklet.mjs', import.meta.url));
      if (this.closed) return;
      this.source = this.context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      this.node = new AudioWorkletNode(this.context, 'deskmate-rolling-audio');
      this.node.port.onmessage = ({ data }) => {
        const request = this.requests.get(data.id);
        if (!request) return;
        clearTimeout(request.timer); this.requests.delete(data.id); request.resolve(data);
      };
      this.source.connect(this.node); this.node.connect(this.context.destination);
      await this.context.resume();
    } catch (error) { this.dispose(); throw error; }
  }
  async snapshot() {
    if (this.stopping) return this.stopping;
    await this.ready;
    if (this.closed) return this.last ?? null;
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('读取音频缓存超时，请重新选择课程窗口')); }, 3000);
      this.requests.set(id, { resolve, reject, timer });
      this.node.port.postMessage({ type: 'snapshot', id });
    });
  }
  async snapshotSince(afterTotal = 0) {
    const snapshot = await this.snapshot();
    return snapshot ? sliceUntranscribedAudio(snapshot, afterTotal) : null;
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.snapshot().then(snapshot => { this.last = snapshot; return snapshot; }).finally(() => this.dispose());
    return this.stopping;
  }
  dispose() {
    this.closed = true;
    this.source?.disconnect(); this.node?.disconnect(); this.node?.port.close();
    if (this.context.state !== 'closed') this.context.close().catch(() => {});
    for (const { reject, timer } of this.requests.values()) { clearTimeout(timer); reject(new Error('音频采集已结束')); }
    this.requests.clear();
  }
}
