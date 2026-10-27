import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ENGINE_FILES, QWEN_SOURCE, prepareQwenEngine } from '../scripts/prepare-qwen-engine.mjs';

const archive = fileURLToPath(new URL(`../.local/qwen-downloads/qwen-source-${QWEN_SOURCE.commit}.zip`, import.meta.url));
async function workspace() {
  const parent = path.resolve('.local'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'qwen-preparation-test-'));
  await mkdir(path.join(root, 'assets/licenses'), { recursive: true });
  await writeFile(path.join(root, 'assets/licenses/Qwen-GGUF-NOTICE.txt'), 'Test attribution\n');
  return { root, destination: path.join(root, 'runtime'), async cleanup() {
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('qwen-preparation-test-')) throw new Error('Unexpected test cleanup path');
    await rm(root, { recursive: true, force: true });
  } };
}

test('verified source archive builds the tested engine in an empty root without vendored upstream source', { skip: !existsSync(archive) }, async () => {
  const temp = await workspace();
  try {
    await prepareQwenEngine({ ...temp, download: async (url, _name, hash, _seed, bytes) => {
      assert.equal(url, QWEN_SOURCE.url); assert.equal(hash, QWEN_SOURCE.sha256); assert.equal(bytes, QWEN_SOURCE.bytes); return archive;
    } });
    assert.equal(existsSync(path.join(temp.root, 'src/native/qwen')), false);
    for (const [name, , outputHash] of ENGINE_FILES) {
      const output = await readFile(path.join(temp.destination, 'engine/qwen_asr_gguf', name));
      assert.equal(createHash('sha256').update(output).digest('hex'), outputHash, name);
    }
    assert.equal(await readFile(path.join(temp.destination, 'engine/NOTICE.txt'), 'utf8'), 'Test attribution\n');
  } finally { await temp.cleanup(); }
});

test('a changed source archive is rejected before modifying an existing engine', async () => {
  const temp = await workspace();
  try {
    const bad = path.join(temp.root, 'bad.zip'); await writeFile(bad, 'Untrusted archive contents');
    const existing = path.join(temp.destination, 'engine/qwen_asr_gguf/inference/asr.py');
    await mkdir(path.dirname(existing), { recursive: true }); await writeFile(existing, 'Existing engine sentinel\n');
    await assert.rejects(prepareQwenEngine({ ...temp, download: async () => bad }), /archive checksum/);
    assert.equal(await readFile(existing, 'utf8'), 'Existing engine sentinel\n');
  } finally { await temp.cleanup(); }
});
