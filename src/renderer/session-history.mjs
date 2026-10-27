import { validateSession } from './buffer.mjs';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function completed(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('记录保存失败'));
  });
}
export function sessionSummary(id, data) {
  const namedTitle = data.title || data.messages.find(message => message.role === 'user')?.text || data.source;
  const title = namedTitle || '未命名的学习';
  return { id, title: title.replace(/\s+/g, ' ').trim().slice(0, 80), savedAt: data.savedAt,
    generatedTitle: !namedTitle,
    search: data.messages.map(message => message.text).join('\n'),
    empty: !data.courseContext?.text && !data.draft && !data.messages.length && !data.frames.length && !data.analyses?.length && !data.transcripts.length
      && !(Number.isFinite(data.diagnostics?.queuedImages) && data.diagnostics.queuedImages > 0) };
}
export class SessionHistory {
  constructor(db) { this.db = db; }
  static async open() {
    const request = indexedDB.open('deskmate', 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['sessions', 'sessionIndex', 'historyState']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      const cursor = request.transaction.objectStore('sessions').openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result; if (!row) return;
        const data = { ...row.value, frames: [] };
        row.update(data);
        if (row.key !== 'latest') request.transaction.objectStore('sessionIndex').put(sessionSummary(row.key, data), row.key);
        row.continue();
      };
    };
    const history = new SessionHistory(await requestResult(request));
    history.db.onversionchange = () => history.db.close();
    const legacy = await history.get('latest');
    if (legacy) {
      validateSession(legacy);
      // Copy the old record, its index and active pointer atomically before removing the legacy key.
      await history.save(crypto.randomUUID(), legacy, true);
    }
    return history;
  }
  get(id) { return requestResult(this.db.transaction('sessions').objectStore('sessions').get(id)); }
  active() { return requestResult(this.db.transaction('historyState').objectStore('historyState').get('active')); }
  async list() {
    const items = await requestResult(this.db.transaction('sessionIndex').objectStore('sessionIndex').getAll());
    const visible = items.filter(item => !item.empty);
    await Promise.all(visible.filter(item => item.generatedTitle === undefined && item.title === '未命名的学习').map(async item => {
      const data = await this.get(item.id);
      if (data) item.generatedTitle = sessionSummary(item.id, data).generatedTitle;
    }));
    return visible.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async save(id, data, migrate = false) {
    data = { ...data, frames: [] };
    const tx = this.db.transaction(['sessions', 'sessionIndex', 'historyState'], 'readwrite');
    const done = completed(tx);
    tx.objectStore('sessions').put(data, id);
    tx.objectStore('sessionIndex').put(sessionSummary(id, data), id);
    tx.objectStore('historyState').put(id, 'active');
    if (migrate) tx.objectStore('sessions').delete('latest');
    await done;
  }
  async activate(id) {
    const tx = this.db.transaction('historyState', 'readwrite');
    const done = completed(tx);
    tx.objectStore('historyState').put(id, 'active');
    await done;
  }
  async rename(id, title) {
    const tx = this.db.transaction(['sessions', 'sessionIndex'], 'readwrite'), done = completed(tx);
    const request = tx.objectStore('sessions').get(id);
    request.onsuccess = () => {
      if (!request.result) { tx.abort(); return; }
      const data = { ...request.result, title: title.slice(0, 80) };
      tx.objectStore('sessions').put(data, id); tx.objectStore('sessionIndex').put(sessionSummary(id, data), id);
    };
    await done;
  }
  async remove(id) {
    const tx = this.db.transaction(['sessions', 'sessionIndex'], 'readwrite'), done = completed(tx);
    tx.objectStore('sessions').delete(id); tx.objectStore('sessionIndex').delete(id);
    await done;
  }
}
