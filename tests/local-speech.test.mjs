import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { encodeWav } from '../src/core/audio-buffer.mjs';
import { decodeSpeechWav } from '../src/core/speech-wav.mjs';
import { LocalSpeech, defaultSpeechRuntimeDir } from '../src/core/local-speech.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const silence = seconds => Buffer.from(encodeWav({ samples: new Float32Array(16000 * seconds), sampleRate: 16000 }));
test('local speech validates actual PCM data and rejects oversized, wrong-format and truncated recordings', () => {
  const wav = silence(120), decoded = decodeSpeechWav(wav);
  assert.equal(decoded.samples.length, 1920000);
  assert.equal(decoded.sampleRate, 16000);
  assert.ok(decoded.samples.every(x => x === 0));
  assert.throws(() => decodeSpeechWav(silence(121)), /两分钟/);
  assert.throws(() => decodeSpeechWav(wav.subarray(0, wav.length - 1)), /有效/);
  const stereo = silence(1); stereo.writeUInt16LE(2, 22);
  assert.throws(() => decodeSpeechWav(stereo), /单声道/);
  const badChunk = silence(1); badChunk.writeUInt32LE(0xffffffff, 40);
  assert.throws(() => decodeSpeechWav(badChunk), /不完整/);
});
for (const action of ['cancel', 'timeout', 'dispose']) {
  test(`local speech ${action} rejects pending work and stops only its own worker`, async () => {
    let child;
    const speech = new LocalSpeech({ timeoutMs: action === 'timeout' ? 100 : 5000,
      spawnImpl: (_file, args, options) => (child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/speech-worker.mjs', import.meta.url)), 'hang', args.at(-1)], options)) });
    const controller = new AbortController();
    const pending = speech.transcribe(silence(1), 'audio/wav', controller.signal);
    const closed = once(child, 'exit');
    await assert.rejects(speech.transcribe(silence(1), 'audio/wav'), /正在处理/);
    if (action === 'cancel') controller.abort();
    if (action === 'dispose') speech.dispose();
    await assert.rejects(pending, action === 'timeout' ? /超时/ : /取消/);
    await closed;
    assert.equal(speech.child, null);
    assert.equal(speech.pending, null);
    speech.dispose();
  });
}
test('bundled native recognizer returns no invented text for silence and can restart after idle release', {
  // Two cold starts may each use the production 90-second request allowance.
  skip: !existsSync(path.join(defaultSpeechRuntimeDir(), 'manifest.json')), timeout: 190000,
}, async t => {
  const started = performance.now();
  const phase = (name, details = '') => t.diagnostic(`${name}: elapsed_ms=${Math.round(performance.now() - started)}${details ? ` ${details}` : ''}`);
  const speech = new LocalSpeech({ idleMs: 50 });
  try {
    phase('first-transcribe-start', 'audio_seconds=120');
    const result = await speech.transcribe(silence(120), 'audio/wav');
    phase('first-transcribe-complete', `mode=${result.mode}`);
    assert.match(result.model, /^Qwen3-ASR/); assert.equal(result.source, 'local'); assert.equal(result.text, ''); assert.deepEqual(result.segments, []);
    const first = speech.child, closed = once(first, 'exit');
    phase('idle-release-wait');
    await closed;
    phase('idle-release-complete');
    assert.equal(speech.child, null);
    phase('second-transcribe-start', 'audio_seconds=1');
    const second = await speech.transcribe(silence(1), 'audio/wav');
    phase('second-transcribe-complete', `mode=${second.mode}`);
    assert.equal(second.text, '');
    assert.notEqual(speech.child, first);
  } finally { speech.dispose(); phase('disposed'); }
});

function fixture(scenario,calls){return (_file,args,options)=>{calls.push(args.at(-1));return spawn(process.execPath,[fileURLToPath(new URL('./fixtures/speech-worker.mjs',import.meta.url)),scenario,args.at(-1)],options);};}
test('a failed GPU worker exits before a CPU worker uses the same Qwen request; fallback notice appears once',async()=>{
 const calls=[],speech=new LocalSpeech({spawnImpl:fixture('fallback',calls)});
 try{const result=await speech.transcribe(silence(1),'audio/wav');assert.deepEqual(calls,['gpu','cpu']);assert.equal(result.mode,'cpu');assert.match(result.notice,/Qwen/);assert.equal(result.inputBytes,silence(1).length);
 const second=await speech.transcribe(silence(1),'audio/wav');assert.equal(second.notice,undefined);assert.deepEqual(calls,['gpu','cpu']);}finally{speech.dispose();}
});
test('a question waits for model warmup without transcribing synthetic audio as user speech',async()=>{
 const calls=[],speech=new LocalSpeech({spawnImpl:fixture('normal',calls)});
 try{const warming=speech.warmup();const answer=speech.transcribe(silence(1),'audio/wav');await warming;assert.equal((await answer).text,'测试转写');assert.deepEqual(calls,['gpu']);}finally{speech.dispose();}
});
test('cancelling while waiting for warmup returns promptly without queueing user audio',async()=>{
 const calls=[],speech=new LocalSpeech({spawnImpl:fixture('normal',calls)}),controller=new AbortController();
 try{const warming=speech.warmup();const answer=speech.transcribe(silence(1),'audio/wav',controller.signal);controller.abort();await assert.rejects(answer,/取消/);assert.equal((await warming).warmed,true);}finally{speech.dispose();}
});
