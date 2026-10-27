import { mkdir, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SESSION = /^[a-zA-Z0-9_-]{1,100}$/;
const EVENT = /^[a-zA-Z0-9._:-]{1,180}$/;
const IMAGE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
function validate(input) {
  const frame = input?.frame;
  if (!frame || typeof frame.eventId !== 'string' || !EVENT.test(frame.eventId)) throw new Error('待处理截图编号无效');
  if (!Number.isFinite(frame.time) || frame.time < 0 || typeof frame.image !== 'string' || !IMAGE.test(frame.image)
    || frame.image.length > 2_000_000 * 4 / 3 || typeof input.source !== 'string' || input.source.length > 500) throw new Error('待处理截图格式无效');
  for (const key of ['id', 'width', 'height', 'change']) if (frame[key] !== undefined && (!Number.isFinite(frame[key]) || frame[key] < 0)) throw new Error('待处理截图格式无效');
  return { frame: { eventId: frame.eventId, time: frame.time, image: frame.image,
    ...Object.fromEntries(['id', 'width', 'height', 'change'].filter(key => frame[key] !== undefined).map(key => [key, frame[key]])) }, source: input.source };
}

/** Only pending work lives here. Completed notes and the model conversation have separate stores. */
export class PendingFrames {
  constructor({ root }) { this.root = path.resolve(root); this.locks = new Map(); this.orders = new Map(); }
  folder(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION.test(sessionId)) throw new Error('学习会话编号无效');
    return path.join(this.root, sessionId);
  }
  file(sessionId, eventId) {
    if (typeof eventId !== 'string' || !EVENT.test(eventId)) throw new Error('待处理截图编号无效');
    return path.join(this.folder(sessionId), `${createHash('sha256').update(eventId).digest('hex')}.json`);
  }
  async exclusive(sessionId, work) {
    this.folder(sessionId);
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work); this.locks.set(sessionId, next);
    try { return await next; } finally { if (this.locks.get(sessionId) === next) this.locks.delete(sessionId); }
  }
  async read(sessionId, file) {
    const record = JSON.parse(await readFile(file, 'utf8'));
    const input = validate(record);
    if (record.version !== 1 || record.sessionId !== sessionId || record.eventId !== input.frame.eventId
      || !Number.isSafeInteger(record.order) || record.order < 0 || this.file(sessionId, record.eventId) !== file) throw new Error('待处理截图格式无效');
    return { ...input, version: 1, sessionId, eventId: record.eventId, order: record.order };
  }
  async records(sessionId) {
    const folder = this.folder(sessionId);
    let names;
    try { names = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) records.push(await this.read(sessionId, path.join(folder, name)));
    return records.sort((a, b) => a.order - b.order || a.frame.time - b.frame.time || a.eventId.localeCompare(b.eventId));
  }
  async save(sessionId, input) {
    const value = validate(input), file = this.file(sessionId, value.frame.eventId);
    return this.exclusive(sessionId, async () => {
      try {
        let existing;
        try { existing = await this.read(sessionId, file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing) {
          if (JSON.stringify({ frame: existing.frame, source: existing.source }) !== JSON.stringify(value)) throw new Error('待处理截图编号已用于其他内容');
          return true;
        }
        await mkdir(this.folder(sessionId), { recursive: true });
        if (!this.orders.has(sessionId)) this.orders.set(sessionId, Math.max(0, ...(await this.records(sessionId)).map(record => record.order)));
        const order = Math.max(Date.now(), this.orders.get(sessionId) + 1);
        const record = { version: 1, sessionId, eventId: value.frame.eventId, order, ...value };
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(record), { flag: 'wx', flush: true });
          for (let attempt = 0; ; attempt++) {
            try { await rename(temporary, file); break; }
            catch (error) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 9) throw error; await delay(50); }
          }
        } finally { await unlink(temporary).catch(() => {}); }
        this.orders.set(sessionId, order); return true;
      } catch (error) {
        if (error.message === '待处理截图编号已用于其他内容') throw error;
        throw new Error('待处理截图保存失败，已暂停新增截图，请检查磁盘空间。');
      }
    });
  }
  async list(sessionId) {
    return this.exclusive(sessionId, async () => {
      try {
        const records = await this.records(sessionId);
        this.orders.set(sessionId, Math.max(0, ...records.map(record => record.order)));
        return records.map(({ frame, source }) => ({ frame, source }));
      } catch { throw new Error('待处理截图无法读取，文件仍保留。'); }
    });
  }
  async complete(sessionId, eventId) {
    const file = this.file(sessionId, eventId);
    return this.exclusive(sessionId, async () => {
      try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw new Error('待处理截图清理失败，文件仍保留。'); }
      return true;
    });
  }
  async clear(sessionId) {
    return this.exclusive(sessionId, async () => {
      try {
        let names;
        try { names = await readdir(this.folder(sessionId)); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        for (const name of names.filter(name => /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(name))) await unlink(path.join(this.folder(sessionId), name));
        this.orders.delete(sessionId); return true;
      } catch { throw new Error('待处理截图清理失败，文件仍保留。'); }
    });
  }
  async flush() {
    while (this.locks.size) {
      const results = await Promise.allSettled([...this.locks.values()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
}
