import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSpeechWav } from './speech-wav.mjs';
import { speechPythonPath } from './platform.mjs';

export const defaultSpeechRuntimeDir = () => process.resourcesPath && import.meta.url.includes('app.asar')
  ? path.join(process.resourcesPath, 'qwen-speech')
  : fileURLToPath(new URL('../../.local/qwen-speech/', import.meta.url));
export const defaultSpeechModelDir = () => path.join(defaultSpeechRuntimeDir(), 'model');

function workerEnvironment() {
  // The native loader appends its library directory to PATH during import.
  const env = { PATH: process.env.PATH || process.env.Path || '/usr/bin:/bin' };
  for (const name of ['SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','ProgramFiles','ProgramFiles(x86)','GGML_VK_VISIBLE_DEVICES','GGML_VK_DISABLE_F16']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, ...(process.env.NEKOMATE_SPEECH_DIAGNOSTICS === '1' ? { NEKOMATE_SPEECH_DIAGNOSTICS: '1' } : {}), PYTHONIOENCODING: 'utf-8', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' };
}

export class LocalSpeech {
  constructor({ runtimeDir = defaultSpeechRuntimeDir(), idleMs = 60_000, timeoutMs = 90_000, spawnImpl = spawn, mode = 'gpu' } = {}) {
    Object.assign(this, { runtimeDir, idleMs, timeoutMs, spawnImpl, mode });
    this.serial = 0;
  }
  async transcribe(bytes, mimeType, signal) {
    if (signal?.aborted) throw new Error('请求已取消');
    if (mimeType !== 'audio/wav') throw new Error('本地转写需要 WAV 录音');
    decodeSpeechWav(bytes);
    if (this.pending?.kind === 'warmup') {
      const warming = this.pending.promise;
      await new Promise((resolve, reject) => {
        const abort = () => { signal?.removeEventListener('abort', abort); reject(new Error('请求已取消')); };
        signal?.addEventListener('abort', abort, { once: true });
        warming.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
      });
    }
    if (signal?.aborted) throw new Error('请求已取消');
    return this.request('transcribe', Buffer.from(bytes), signal);
  }
  warmup() {
    if (this.disposed) return Promise.reject(new Error('请求已取消'));
    if (this.pending) return this.pending.promise;
    return this.request('warmup');
  }
  request(kind, bytes, signal) {
    if (this.disposed || signal?.aborted) return Promise.reject(new Error('请求已取消'));
    if (this.pending) return Promise.reject(new Error('本地转写正在处理中，请稍后重试'));
    clearTimeout(this.idleTimer);
    const request = { kind };
    const promise = new Promise((resolve, reject) => {
      const finish = (error, value, stop = false) => {
        if (this.pending !== request) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = null;
        if (stop) this.stopChild();
        else { this.idleTimer = setTimeout(() => this.stopChild(), this.idleMs); this.idleTimer.unref?.(); }
        if (!error && kind === 'transcribe' && this.fallbackNotice) {
          value = { ...value, notice: '显卡暂不可用，本次已使用 Qwen 在 CPU 上转写，速度可能稍慢。' };
          this.fallbackNotice = false;
        }
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error('请求已取消'), null, true);
      const timer = setTimeout(() => finish(new Error('本地语音转写超时，请重试'), null, true), this.timeoutMs);
      request.finish = finish; this.pending = request;
      signal?.addEventListener('abort', abort, { once: true });
      const attempt = () => {
        if (this.pending !== request || signal?.aborted) return;
        const id = ++this.serial, mode = this.mode;
        request.id = id;
        const failed = () => {
          if (this.pending !== request || request.id !== id) return;
          if (mode === 'gpu') {
            this.mode = 'cpu'; this.fallbackNotice = true;
            const child = this.child;
            this.stopChild();
            if (child && child.exitCode === null && child.signalCode === null) child.once('exit', attempt);
            else queueMicrotask(attempt);
          } else finish(new Error('本地语音转写失败，请确认语音组件完整并重试'), null, true);
        };
        try {
          let child = this.child;
          if (!child) {
            child = this.spawnImpl(speechPythonPath(this.runtimeDir), ['-I', '-u', path.join(this.runtimeDir, 'worker.py'), mode], {
              windowsHide: true, stdio: ['pipe', 'pipe', process.env.NEKOMATE_SPEECH_DIAGNOSTICS === '1' ? 'inherit' : 'ignore'], env: workerEnvironment(), cwd: this.runtimeDir,
            });
            this.child = child;
            child.stdout.setEncoding('utf8'); let buffer = '';
            child.stdout.on('data', chunk => {
              if (this.child !== child) return;
              buffer += chunk;
              if (buffer.length > 150_000) { this.pending?.failed(); return; }
              let newline;
              while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
                if (!line) continue;
                let message; try { message = JSON.parse(line); } catch { this.pending?.failed(); return; }
                const pending = this.pending;
                if (!pending || message.id !== pending.id) continue;
                if (message.error || message.result?.mode !== this.mode
                    || (pending.kind === 'warmup' ? message.result?.warmed !== true : typeof message.result?.text !== 'string' || message.result.text.length > 64000)) pending.failed();
                else pending.finish(null, message.result);
              }
            });
            const exited = () => {
              if (this.child !== child) return;
              this.child = null;
              this.pending?.failed();
            };
            child.on('error', exited); child.on('exit', exited);
            child.stdin.on('error', () => { if (this.child === child) this.pending?.failed(); });
          }
          request.failed = failed;
          child.stdin.write(JSON.stringify({ id, kind, ...(bytes ? { audio: bytes.toString('base64') } : {}) }) + '\n', error => {
            if (error && this.pending === request && request.id === id) failed();
          });
        } catch { failed(); }
      };
      attempt();
    });
    request.promise = promise;
    return promise;
  }
  stopChild() {
    clearTimeout(this.idleTimer);
    const child = this.child; this.child = null;
    if (child) { child.stdin.destroy(); child.kill(); }
  }
  dispose() {
    this.disposed = true;
    this.pending?.finish(new Error('请求已取消'), null, true);
    this.stopChild();
  }
}
const localSpeech = new LocalSpeech();
export const transcribeLocally = (bytes, mimeType, signal) => localSpeech.transcribe(bytes, mimeType, signal);
export const warmupLocalSpeech = () => localSpeech.warmup();
export const disposeLocalSpeech = () => localSpeech.dispose();
