import { AudioRing } from '../core/audio-buffer.mjs';

class RollingAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new AudioRing(sampleRate);
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'snapshot') return;
      const snapshot = this.ring.snapshot();
      this.port.postMessage({ id: data.id, ...snapshot }, [snapshot.samples.buffer]);
    };
  }
  process(inputs, outputs) {
    // Keep elapsed silent time too, so an ended/missing source cannot retain old speech.
    this.ring.append(inputs[0]?.length ? inputs[0] : outputs[0]);
    // Output remains silent: the system loopback must never play back into itself.
    return true;
  }
}
registerProcessor('deskmate-rolling-audio', RollingAudioProcessor);
