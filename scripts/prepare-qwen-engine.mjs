import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const QWEN_SOURCE = Object.freeze({
  commit: 'e790e3bfe9c1c52453da1166df236950a8a8b036',
  url: 'https://codeload.github.com/HaujetZhao/Qwen3-ASR-GGUF/zip/e790e3bfe9c1c52453da1166df236950a8a8b036',
  sha256: '9843de33de1f1c2795e0ff0cb24232eb780d20ffdbafe35f1b24dc47dd09bcfe',
  bytes: 29954738,
});

// Hashes identify the upstream files and adapted output, including modification notices.
// Upstream implementation bodies are obtained from the verified archive, not vendored here.
export const ENGINE_FILES = Object.freeze([
  ['__init__.py', 'febac5984210a479129ecf20de19ac3a5c1a5360c24700b70f6b63e39254cf90', 'f00c73e08dff7d99e1d9f92a31321b97b02f7fb7b1e2f7f8603e23f803d2eaca'],
  ['inference/__init__.py', '034ed4ae2992a3f7c1ea104bd282ca9041f36d8824201f042092f096304fe649', '02f91b0565bfa96aeaebccd021f7ed7f113078b4588da9c9848b846925416493'],
  ['inference/asr.py', '38e420d75598cd85d689a665ab20af84f9b01f120fe0c2b1b5275cca49bd11fa', '38e420d75598cd85d689a665ab20af84f9b01f120fe0c2b1b5275cca49bd11fa'],
  ['inference/chinese_itn.py', '309cc4d5e4651c37b4000154451ed9d0bd680c98650230c4357a54594c3fc04e', '309cc4d5e4651c37b4000154451ed9d0bd680c98650230c4357a54594c3fc04e'],
  ['inference/encoder.py', 'b665aa303e2fff5d7106450d34e9faadb0a7630f62771a628bbe57c794e08fee', 'b665aa303e2fff5d7106450d34e9faadb0a7630f62771a628bbe57c794e08fee'],
  ['inference/llama.py', 'c436611fa864ac2dc873a19962562073508092d85015144ff67fb47514d4ce8b', 'b7fbedd8c5e8d4e33c526e64372d202fdbd67a8a54164b94af608f89af945093'],
  ['inference/schema.py', 'b651a3f49c6738b0d336eafdd5012efd62467e3a4ca1b3c498ac507e2588e54b', 'b651a3f49c6738b0d336eafdd5012efd62467e3a4ca1b3c498ac507e2588e54b'],
  ['inference/utils.py', '107b176190a3705ec4d2357ae46994df81bd56395707415ae48e19938edd6bf7', '107b176190a3705ec4d2357ae46994df81bd56395707415ae48e19938edd6bf7'],
]);

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
// Apply only Nekomate's b11724 field changes. Unchanged ABI declarations are
// parsed from the verified upstream file instead of being copied into this repo.
function patchLayout(source, name, modify, groups) {
  const pattern = new RegExp(`class ${name}\\(ctypes\\.Structure\\):[\\s\\S]*?(?=class )`, 'g');
  const blocks = [...source.matchAll(pattern)];
  if (blocks.length !== 1) throw new Error(`Pinned Qwen layout no longer matches: ${name}`);
  const fields = [...blocks[0][0].matchAll(/^\s*\("([^"]+)", (.+)\),?\s*$/gm)].map(match => [match[1], match[2]]);
  const index = key => { const i = fields.findIndex(field => field[0] === key); if (i < 0) throw new Error(`Missing Qwen ABI field: ${key}`); return i; };
  modify({ fields, index,
    insert: (after, ...added) => fields.splice(index(after) + 1, 0, ...added),
    type: (key, type) => { fields[index(key)][1] = type; },
    remove: key => fields.splice(index(key), 1) });
  const chunks = groups ?? fields.map(() => 1), lines = []; let cursor = 0;
  for (const count of chunks) { lines.push('        ' + fields.slice(cursor, cursor + count).map(([key, type]) => `("${key}", ${type}),`).join(' ')); cursor += count; }
  if (cursor !== fields.length) throw new Error(`Invalid Qwen ABI formatting: ${name}`);
  return source.replace(pattern, `class ${name}(ctypes.Structure):\n    _fields_ = [\n${lines.join('\n')}\n    ]\n`);
}
function modified(name, body) {
  const changes = {
    '__init__.py': 'minimal package imports and non-persistent logging.',
    'inference/__init__.py': 'load only the ASR engine and its configuration.',
    'inference/llama.py': 'llama.cpp b11724 ctypes ABI and disabled file logging.',
  };
  const notice = `# Modified by Nekomate: ${changes[name]}\r\n# Adapted from Qwen3-ASR-GGUF commit ${QWEN_SOURCE.commit}.\r\n`;
  return Buffer.concat([Buffer.from(notice), body]);
}
function adapt(name, bytes) {
  if (name === '__init__.py') return modified(name, Buffer.from('import logging\r\nlogger=logging.getLogger("nekomate.qwen")\r\nlogger.addHandler(logging.NullHandler())\r\nlogger.propagate=False\r\n'));
  if (name === 'inference/__init__.py') return modified(name, Buffer.from('from .. import logger\r\nfrom .asr import QwenASREngine\r\nfrom .schema import ASREngineConfig\r\n'));
  if (name !== 'inference/llama.py') return bytes;
  let source = bytes.toString('utf8');
  if ((source.match(/LOGS = True/g) ?? []).length !== 1) throw new Error('Pinned Qwen log setting no longer matches');
  source = patchLayout(source, 'llama_model_params', ({ fields, insert, type, remove }) => {
    type('tensor_buft_overrides', 'ctypes.c_void_p'); type('kv_overrides', 'ctypes.c_void_p');
    insert('split_mode', ['load_mode', 'ctypes.c_int32'], ['lazy_mode', 'ctypes.c_int32']);
    for (const key of ['use_mmap', 'use_direct_io', 'use_mlock']) remove(key);
    fields.push(['load_mtp', 'ctypes.c_bool']);
  });
  source = patchLayout(source, 'llama_context_params', ({ fields, insert, type }) => {
    insert('n_seq_max', ['n_rs_seq', 'ctypes.c_uint32'], ['n_outputs_max', 'ctypes.c_uint32'], ['n_outputs_max_per_seq', 'ctypes.c_uint32']);
    insert('n_threads_batch', ['ctx_type', 'ctypes.c_int32']);
    insert('type_v', ['moe_cache_size', 'ctypes.c_size_t']);
    type('samplers', 'ctypes.c_void_p'); fields.push(['ctx_other', 'ctypes.c_void_p']);
  }, [2, 2, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1]);
  // Preserve the CRLF bytes of the previously verified Windows runtime.
  return modified(name, Buffer.from(source.replace('LOGS = True', 'LOGS = False').replace(/\r?\n/g, '\r\n')));
}

export async function prepareQwenEngine({ root, destination, download }) {
  const archive = await download(QWEN_SOURCE.url, `qwen-source-${QWEN_SOURCE.commit}.zip`, QWEN_SOURCE.sha256,
    path.join(root, '.local/qwen-benchmark/source.zip'), QWEN_SOURCE.bytes);
  if (sha256(await readFile(archive)) !== QWEN_SOURCE.sha256) throw new Error('Qwen source archive checksum failed');
  const prefix = `Qwen3-ASR-GGUF-${QWEN_SOURCE.commit}/qwen_asr_gguf/`;
  const prepared = [];
  for (const [name, sourceHash, outputHash] of ENGINE_FILES) {
    const { stdout } = await run('tar', ['-xOf', archive, `${prefix}${name}`], { windowsHide: true, encoding: 'buffer', maxBuffer: 2_000_000 });
    if (sha256(stdout) !== sourceHash) throw new Error(`Qwen source checksum failed: ${name}`);
    const output = adapt(name, stdout);
    if (sha256(output) !== outputHash) throw new Error(`Qwen adapted output checksum failed: ${name}`);
    prepared.push({ name, output });
  }
  for (const { name, output } of prepared) {
    const target = path.join(destination, 'engine/qwen_asr_gguf', name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(`${target}.tmp`, output); await rename(`${target}.tmp`, target);
  }
  await copyFile(path.join(root, 'assets/licenses/Qwen-GGUF-NOTICE.txt'), path.join(destination, 'engine/NOTICE.txt'));
  console.log(`Qwen engine prepared from verified commit ${QWEN_SOURCE.commit}; ${prepared.length} output hashes verified.`);
  return QWEN_SOURCE;
}
