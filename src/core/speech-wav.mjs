// Accept the bounded PCM format emitted by AudioRing. Validate before native code.
export function decodeSpeechWav(input) {
  const bytes = Buffer.from(input);
  if (bytes.length < 44 || bytes.length > 4_000_000 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) !== bytes.length - 8) throw new Error('录音不是有效的 WAV 文件');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8, end = start + size;
    if (end > bytes.length) throw new Error('录音数据不完整');
    const kind = bytes.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') { if (format) throw new Error('录音格式重复'); format = bytes.subarray(start, end); }
    if (kind === 'data') { if (data) throw new Error('录音数据重复'); data = bytes.subarray(start, end); }
    offset = end + (size % 2);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 || format.readUInt32LE(8) !== 32000 || format.readUInt16LE(12) !== 2 || format.readUInt16LE(14) !== 16) throw new Error('录音需要 16 kHz 单声道 PCM WAV 格式');
  if (!data?.length || data.length % 2 || data.length > 120 * 16000 * 2) throw new Error('录音时长必须在两分钟以内');
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: 16000 };
}
