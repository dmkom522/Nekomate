import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import path from 'node:path';
import { PendingFrames } from '../src/core/pending-frames.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(red, green, blue) {
  const chunk = (name, data) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), check = Buffer.alloc(4);
    length.writeUInt32BE(data.length); check.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const blueBytes = png(20, 60, 210), greenBytes = png(30, 180, 70);
const entry = (eventId, time, bytes = blueBytes) => ({ frame: { id: 1, eventId, time, image: `data:image/png;base64,${bytes.toString('base64')}`, width: 1, height: 1, change: 0.9 }, source: '课程窗口' });
const filename = eventId => createHash('sha256').update(eventId).digest('hex') + '.json';
const diskFile = (root, sessionId, eventId) => path.join(root, sessionId, filename(eventId));
async function setup(t) {
  const temporaryRoot = path.resolve('.local'); await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, 'pending-frames-unit-'));
  t.after(async () => { assert.equal(path.dirname(root), temporaryRoot); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { root, store: new PendingFrames({ root }) };
}

test('pending screenshot bytes and insertion order survive a fresh store instance without relying on metadata alone', async t => {
  const { root, store } = await setup(t);
  const blue = entry('capture:blue', 20), green = entry('capture:green', 10, greenBytes);
  await store.save('lecture', blue); await store.save('lecture', green); await store.flush();
  const envelope = JSON.parse(await readFile(diskFile(root, 'lecture', blue.frame.eventId), 'utf8'));
  const bytes = Buffer.from(envelope.frame.image.split(',')[1], 'base64');
  assert.deepEqual(bytes, blueBytes);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const idatOffset = bytes.indexOf(Buffer.from('IDAT'));
  const idatSize = bytes.readUInt32BE(idatOffset - 4);
  assert.deepEqual([...inflateSync(bytes.subarray(idatOffset + 4, idatOffset + 4 + idatSize))], [0, 20, 60, 210, 255]);
  assert.equal(envelope.sessionId, 'lecture'); assert.equal(envelope.eventId, blue.frame.eventId);
  const reopened = new PendingFrames({ root });
  assert.deepEqual(await reopened.list('lecture'), [blue, green], 'queue order follows capture acceptance, including nonmonotonic relative times');
  await reopened.save('lecture', entry('capture:third', 1));
  assert.deepEqual((await new PendingFrames({ root }).list('lecture')).map(item => item.frame.eventId), ['capture:blue', 'capture:green', 'capture:third']);
});

test('same event is idempotent including concurrent saves, while changed content cannot silently overwrite it', async t => {
  const { root, store } = await setup(t);
  const saved = entry('same-event', 3);
  await Promise.all([store.save('lecture', saved), store.save('lecture', saved), store.save('lecture', saved)]);
  const before = await readFile(diskFile(root, 'lecture', 'same-event'), 'utf8');
  assert.deepEqual(await store.list('lecture'), [saved]);
  await assert.rejects(store.save('lecture', { ...saved, source: '其他课程' }));
  await assert.rejects(store.save('lecture', entry('same-event', 3, greenBytes)));
  assert.equal(await readFile(diskFile(root, 'lecture', 'same-event'), 'utf8'), before);
});

test('flush waits for an in-flight durable screenshot save rather than only already completed writes', async t => {
  const { root, store } = await setup(t);
  let entered, release;
  const reachedRead = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const read = store.read.bind(store);
  store.read = async (...args) => { entered(); await gate; return read(...args); };
  const input = entry('flush-pending', 0);
  const saving = store.save('lecture', input);
  await reachedRead;
  let flushed = false;
  const flushing = store.flush().then(() => { flushed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flushed, false);
  release(); await Promise.all([saving, flushing]);
  assert.equal(flushed, true);
  const disk = JSON.parse(await readFile(diskFile(root, 'lecture', input.frame.eventId), 'utf8'));
  assert.deepEqual(Buffer.from(disk.frame.image.split(',')[1], 'base64'), blueBytes);
});

test('an atomic write failure preserves all prior screenshot bytes and does not publish a partial entry', async t => {
  const { root, store } = await setup(t);
  const prior = entry('already-durable', 0); await store.save('lecture', prior);
  const priorFile = diskFile(root, 'lecture', prior.frame.eventId), before = await readFile(priorFile);
  const blockedTarget = diskFile(root, 'lecture', 'blocked');
  const read = store.read.bind(store), temporaryEvents = [];
  // Materialize a conflicting directory after the real existence check has seen
  // ENOENT, so this exercises the actual temporary write + failed atomic rename.
  store.read = async (sessionId, file) => {
    try { return await read(sessionId, file); }
    catch (error) { if (file === blockedTarget && error.code === 'ENOENT') await mkdir(blockedTarget); throw error; }
  };
  const watcher = watch(path.dirname(blockedTarget), (_event, name) => { if (String(name).startsWith(filename('blocked') + '.') && String(name).endsWith('.tmp')) temporaryEvents.push(String(name)); });
  try { await assert.rejects(store.save('lecture', entry('blocked', 1, greenBytes))); }
  finally { watcher.close(); }
  assert.ok(temporaryEvents.length > 0, 'an actual temporary screenshot file was written before replacement failed');
  assert.deepEqual(await readFile(priorFile), before);
  await rmdir(blockedTarget);
  assert.deepEqual(await new PendingFrames({ root }).list('lecture'), [prior]);
  assert.equal((await readdir(path.join(root, 'lecture'))).filter(name => name.endsWith('.json')).length, 1);
});

test('completing an event deletes only that screenshot and clearing one learning preserves other queues', async t => {
  const { root, store } = await setup(t);
  const first = entry('first', 0), second = entry('second', 1, greenBytes);
  await store.save('a', first); await store.save('a', second); await store.save('b', first);
  await store.complete('a', 'first'); await store.complete('a', 'first');
  assert.deepEqual(await store.list('a'), [second]);
  assert.deepEqual(await store.list('b'), [first]);
  await assert.rejects(readFile(diskFile(root, 'a', 'first')), error => error.code === 'ENOENT');
  await store.clear('a'); await store.flush();
  assert.deepEqual(await store.list('a'), []);
  assert.deepEqual(await new PendingFrames({ root }).list('b'), [first]);
});

test('storage rejects unsafe session/event identifiers, external images and malformed screenshot fields', async t => {
  const { store } = await setup(t);
  for (const id of ['', '..', '../outside', '..\\outside', '/absolute', 'a/b', 'a'.repeat(101)]) {
    await assert.rejects(store.save(id, entry('valid', 0)), undefined, `unsafe session ${id}`);
    await assert.rejects(store.list(id));
  }
  for (const eventId of ['', '../outside', 'a\\b', 'bad\0id', 'x'.repeat(181)]) await assert.rejects(store.save('safe', entry(eventId, 0)));
  for (const image of ['https://example.com/picture.png', 'file:///private.png', 'javascript:alert(1)', 'data:text/html;base64,YQ==', 'data:image/png;base64,%%%']) {
    const value = entry('bad-image', 0); value.frame.image = image; await assert.rejects(store.save('safe', value));
  }
  for (const time of [-1, NaN, Infinity]) await assert.rejects(store.save('safe', entry('bad-time', time)));
  await assert.rejects(store.save('safe', { ...entry('bad-source', 0), source: 'x'.repeat(501) }));
  assert.deepEqual(await store.list('safe'), []);
});
