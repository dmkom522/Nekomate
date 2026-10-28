import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, copyFile, rename, rm, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SPEECH_FILES } from '../src/core/speech-assets.mjs';
import { prepareQwenEngine, QWEN_SOURCE } from './prepare-qwen-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, '.local/qwen-speech');
const cache = path.join(root, '.local/qwen-downloads');
const run = promisify(execFile);
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Build macOS speech on a native arm64 or x64 Mac');
const arch = process.arch;
const wheels = JSON.parse(await readFile(path.join(root, 'scripts/qwen-wheels-macos.json'), 'utf8'))[arch];
const sources = {
  arm64: {
    python: ['cpython-3.12.10%2B20250409-aarch64-apple-darwin-install_only.tar.gz', '2d6477ecd10191675b7e7979e4b9e811fef36833ef3a7f3aa445eec305ce59a2', 15662494],
    llama: ['llama-b11724-bin-macos-arm64.tar.gz', '4e3c2951302b5fcee8d65327c6e2b28c382d4be87d9ca3af1346a7c092cd3335', 12292733],
  },
  x64: {
    python: ['cpython-3.12.10%2B20250409-x86_64-apple-darwin-install_only.tar.gz', 'd0d51fa22c0e99b58de1b1b4baeca467d6fd0a1424c7509ea280c0796306c481', 15880018],
    llama: ['llama-b11724-bin-macos-x64.tar.gz', 'a21403b0f4f9eb3804307008680d712332060e3e23b1dc258afdc08c0be85cd0', 11781370],
  },
}[arch];
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function valid(file, hash, bytes) { try { return (!bytes || (await stat(file)).size === bytes) && await digest(file) === hash; } catch { return false; } }
async function download(url, name, hash, _seed, bytes) {
  const file = path.join(cache, name);
  if (await valid(file, hash, bytes)) return file;
  const partial = `${file}.part`, proxy = process.env.NEKOMATE_DOWNLOAD_PROXY;
  try {
    await run('curl', ['--fail', '--location', '--retry', '3', '--connect-timeout', '20', '--max-time', '600', ...(proxy ? ['--proxy', proxy] : []), '--output', partial, url], { timeout: 650000, maxBuffer: 2e6 });
    if (!await valid(partial, hash, bytes)) throw new Error(`macOS speech checksum failed: ${name}`);
    await rename(partial, file); return file;
  } finally { await rm(partial, { force: true }); }
}
async function extract(archive, dir) { await mkdir(dir, { recursive: true }); await run('tar', ['-xf', archive, '-C', dir]); }
async function walk(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === '__pycache__' || item.name.endsWith('.pyc')) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(file)); else files.push(file);
  }
  return files;
}
await mkdir(destination, { recursive: true }); await mkdir(cache, { recursive: true });
let previous; try { previous = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8')); } catch {}
let ready = previous?.runtimeRevision === 2 && previous.platform === 'darwin' && previous.arch === arch && JSON.stringify(previous.wheels) === JSON.stringify(wheels) && previous.files?.length > 100;
if (ready) for (const file of previous.files) if (!await valid(path.join(destination, file.path), file.sha256, file.bytes)) { ready = false; break; }
if (!ready) {
  const py = await download(`https://github.com/astral-sh/python-build-standalone/releases/download/20250409/${sources.python[0]}`, `python-macos-${arch}.tar.gz`, sources.python[1], null, sources.python[2]);
  await extract(py, destination);
  await chmod(path.join(destination, 'python/bin/python3.12'), 0o755);
  const model = await download('https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ASR-0.6B-gguf.zip', 'qwen-0.6b.zip', '3684b9cac9978a93c82ceeb93448bb5027c0b2beaf2e0affa35190ba20e545ff');
  const unpacked = path.join(cache, 'model'); await extract(model, unpacked);
  const contents = await walk(unpacked); await mkdir(path.join(destination, 'model'), { recursive: true });
  for (const entry of SPEECH_FILES) {
    const found = contents.find(file => path.basename(file) === entry.name);
    if (!found || !await valid(found, entry.sha256, entry.bytes)) throw new Error(`Invalid Qwen model: ${entry.name}`);
    await copyFile(found, path.join(destination, 'model', entry.name));
  }
  const native = await download(`https://github.com/ggml-org/llama.cpp/releases/download/b11724/${sources.llama[0]}`, `llama-macos-${arch}.tar.gz`, sources.llama[1], null, sources.llama[2]);
  const nativeDir = path.join(cache, `native-macos-${arch}`); await extract(native, nativeDir);
  const bin = path.join(destination, 'engine/qwen_asr_gguf/inference/bin'); await mkdir(bin, { recursive: true });
  for (const file of await walk(nativeDir)) {
    if (/^lib(?:llama|ggml(?:-base|-cpu|-metal|-blas|-rpc)?|omp)(?:\.\d+)*\.dylib$/.test(path.basename(file))) await copyFile(file, path.join(bin, path.basename(file)));
    if (path.basename(file) === 'LICENSE') await copyFile(file, path.join(destination, 'llama-LICENSE.txt'));
  }
  for (const item of wheels) {
    console.log('Preparing macOS speech:', arch, item.name, item.version);
    const wheel = await download(item.url, item.file, item.sha256, null, item.bytes);
    // Wheels are ZIP files; macOS ditto preserves their packaged native libraries.
    const packages = path.join(destination, 'packages'); await mkdir(packages, { recursive: true });
    await run('ditto', ['-x', '-k', wheel, packages]);
  }
}
const nativeBin = path.join(destination, 'engine/qwen_asr_gguf/inference/bin');
for (const file of await walk(nativeBin)) {
  if (!file.endsWith('.dylib')) continue;
  const { stdout } = await run('otool', ['-L', file]);
  for (const match of stdout.matchAll(/^\s+@(?:rpath|loader_path)\/([^\s]+)\s/gm)) {
    try { await stat(path.join(nativeBin, match[1])); }
    catch { throw new Error(`Unbundled macOS native dependency: ${match[1]}`); }
  }
}
await prepareQwenEngine({ root, destination, download });
await copyFile(path.join(root, 'src/native/qwen-worker.py'), path.join(destination, 'worker.py'));
const files = [];
for (const file of await walk(destination)) {
  if (file === path.join(destination, 'manifest.json')) continue;
  files.push({ path: path.relative(destination, file), bytes: (await stat(file)).size, sha256: await digest(file) });
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ platform: 'darwin', arch, runtimeRevision: 2, model: 'Qwen3-ASR 0.6B INT4/Q4_K', sourceCommit: QWEN_SOURCE.commit, python: '3.12.10', llama: 'b11724', hashStage: 'before-platform-code-signing', sources, wheels, files }, null, 2));
console.log(`macOS ${arch} Qwen runtime and model ready; all input SHA-256 hashes verified.`);
