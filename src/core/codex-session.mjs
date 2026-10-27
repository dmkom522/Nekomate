import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { codexAppServerArgs } from './codex-launch.mjs';
import { cliSystemInstructions, terminateProcess } from './codex-cli.mjs';
import { jsonLines } from './streaming.mjs';

// A process is replaceable; a persisted thread is not. No recovery path calls thread/start.
export class CodexSession {
  constructor({ launch, cwd, sessionId, initialInstructions, onState = () => {}, spawnImpl = spawn, timeout = 180000 }) {
    Object.assign(this, { launch, cwd, sessionId, initialInstructions, onState, spawnImpl, timeout });
    this.sequence = 0; this.pending = new Map(); this.active = null;
  }
  async connect() {
    if (this.child) return;
    const child = this.spawnImpl(this.launch.executable, [...this.launch.prefix, ...codexAppServerArgs({ fastMode: true })], {
      cwd: this.cwd, env: this.launch.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child; this.loaded = false;
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    const parse = jsonLines(message => this.receive(message));
    child.stdout.on('data', chunk => { if (this.child !== child) return; try { parse(chunk); } catch { this.fail(new Error('Codex 会话响应格式不兼容')); this.dispose(); } });
    child.on('error', () => { if (this.child === child) this.fail(new Error('无法启动 Codex CLI')); });
    child.stdin.on('error', () => { if (this.child === child) this.fail(new Error('Codex 会话连接已断开')); });
    child.on('close', () => { if (this.child === child) { this.child = null; this.fail(new Error('Codex 会话连接已断开；请重试恢复原会话')); } });
    await this.rpc('initialize', { clientInfo: { name: 'nekomate', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  send(value) { if (!this.child?.stdin.writable) throw new Error('Codex 会话连接已关闭'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  rpc(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 会话请求超时（${method}）`)); }, 25000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(message) {
    if (message.id !== undefined && message.method) {
      this.send({ id: message.id, error: { code: -32601, message: 'Local tools and approvals are unavailable' } });
      this.active?.reject(new Error('当前课程任务不支持本机工具操作')); return;
    }
    const waiter = this.pending.get(message.id);
    if (waiter) {
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error(`Codex ${waiter.method ?? '会话'}请求失败，请检查登录、模型或原会话是否仍存在`), { code: message.error.code }));
      else waiter.resolve(message.result);
      return;
    }
    const active = this.active, p = message.params;
    if (!active || p?.threadId !== this.sessionId) return;
    const notificationTurn = p.turnId ?? (message.method === 'turn/completed' ? p.turn?.id : undefined);
    if (active.nativeTurnId && notificationTurn && notificationTurn !== active.nativeTurnId) return;
    if (message.method === 'item/agentMessage/delta') {
      const key = p.itemId ?? 'answer', previous = active.items.get(key) ?? '';
      active.items.set(key, previous + p.delta); active.emit(p.delta);
    } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      const key = p.item.id ?? 'answer', previous = active.items.get(key) ?? '';
      if (typeof p.item.text === 'string' && p.item.text.startsWith(previous)) active.emit(p.item.text.slice(previous.length));
      active.items.set(key, p.item.text ?? previous);
    } else if (message.method === 'turn/completed') {
      active.terminal = true;
      active.nativeTurnId = p.turn?.id;
      if (p.turn?.status === 'completed') active.resolve();
      else active.reject(new Error(active.cancelled ? '请求已取消' : 'Codex 回答未完成，重试将继续原会话'));
    } else if (message.method === 'error' && !p.willRetry) active.reject(new Error('Codex 回答失败，请检查账户、模型和网络；原会话已保留'));
    // Context compaction is performed by Codex inside this same thread.
  }
  fail(error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear(); this.active?.reject(error);
  }
  params(allowWeb = false) {
    return { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only',
      baseInstructions: cliSystemInstructions(this.initialInstructions, { allowWeb }),
      config: { mcp_servers: {}, project_doc_max_bytes: 0, web_search: allowWeb ? 'live' : 'disabled' } };
  }
  async create({ allowWeb = false } = {}) {
    await this.connect();
    const result = await this.rpc('thread/start', { ...this.params(allowWeb), ephemeral: false });
    const id = result?.thread?.id;
    if (!id) throw new Error('Codex 没有返回会话编号');
    this.sessionId = id;
    this.loaded = true; this.allowWeb = allowWeb;
    await this.onState({ sessionId: id, state: 'ready' });
    return id;
  }
  async validateResume() {
    if (!this.sessionId) throw new Error('缺少原 Codex 会话，请开始新的学习');
    await this.connect();
    if (this.loaded) return;
    await this.rpc('thread/resume', { ...this.params(), threadId: this.sessionId, excludeTurns: true });
    this.loaded = true; this.allowWeb = false;
  }
  async identity() {
    await this.connect();
    const result = await this.rpc('config/read', { includeLayers: false });
    const config = result?.config ?? {};
    const provider = config.model_provider ?? 'openai';
    const entry = config.model_providers?.[provider] ?? {};
    const account = await this.rpc('account/read', {}).catch(() => null);
    const identity = { provider, providerSettings: entry, account: account?.account ?? null,
      key: entry.env_key ? this.launch.env?.[entry.env_key] ?? '' : '',
      openaiKey: this.launch.env?.OPENAI_API_KEY ?? '', codexKey: this.launch.env?.CODEX_API_KEY ?? '' };
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
  async hasEvent(eventId) {
    await this.connect();
    // Only used after an uncertain transport failure. Never replay an uncertain input.
    const matches = turns => turns.some(turn => (turn.items ?? []).some(item => item.type === 'userMessage'
      && (item.clientId === eventId || item.content?.some(part => part.text?.includes(`[Nekomate event:${eventId}]`)))));
    let cursor;
    try {
      for (let page = 0; page < 5; page++) {
        const result = await this.rpc('thread/turns/list', { threadId: this.sessionId, itemsView: 'full', sortDirection: 'desc', limit: 10, cursor });
        if (matches(result?.data ?? [])) return true;
        if (!result?.nextCursor || result.nextCursor === cursor) return false;
        cursor = result.nextCursor;
      }
      return false; // Unknown is deliberately not permission to resend old material.
    } catch (error) {
      if (error.code !== -32601) throw error;
      const result = await this.rpc('thread/read', { threadId: this.sessionId, includeTurns: true });
      return matches(result?.thread?.turns ?? []);
    }
  }
  async run({ input, task, eventId, model, fastMode, allowWeb = false, signal, onDelta = () => {} }) {
    if (signal?.aborted) throw new Error('请求已取消');
    await this.validateResume();
    if (allowWeb !== this.allowWeb) {
      await this.rpc('thread/resume', { ...this.params(allowWeb), threadId: this.sessionId, excludeTurns: true });
      this.allowWeb = allowWeb;
    }
    if (this.active) throw new Error('原会话仍在处理上一条消息');
    let finish, fail;
    const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    // Attach immediately: the native terminal notification may precede the turn/start response.
    completed.catch(() => {});
    let text = '';
    const active = { items: new Map(), resolve: finish, reject: fail, emit: delta => {
      if (typeof delta !== 'string') return;
      text += delta; if (text.length > 64000) { fail(new Error('Codex 回答过长')); return; }
      if (!signal?.aborted) onDelta(delta);
    } };
    this.active = active;
    const interrupt = () => {
      active.cancelled = true;
      if (active.nativeTurnId) this.rpc('turn/interrupt', { threadId: this.sessionId, turnId: active.nativeTurnId }).catch(fail);
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    const timer = setTimeout(() => { interrupt(); fail(new Error('Codex 回答超时，原会话已保留')); }, this.timeout);
    try {
      await this.onState({ state: 'sending', pendingEventId: eventId });
      if (signal?.aborted) {
        await this.onState({ state: 'ready', unsubmittedEventId: eventId });
        throw new Error('请求已取消');
      }
      const turn = await this.rpc('turn/start', { threadId: this.sessionId, input: [{ type: 'text', text: task }, ...input],
        clientUserMessageId: eventId, model: model || undefined, serviceTierForTurn: fastMode?.tier ?? 'default',
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
      active.nativeTurnId = turn?.turn?.id;
      await this.onState({ state: 'ready', acceptedEventId: eventId, nativeTurnId: active.nativeTurnId });
      if (signal?.aborted) interrupt();
      await completed;
      if (signal?.aborted) throw new Error('请求已取消');
      if (!text.trim()) throw new Error('Codex 没有返回文字内容');
      return { text, accepted: true, nativeTurnId: active.nativeTurnId, model: model || 'codex', usage: null };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', interrupt);
      this.active = null;
      // A failed transport must not leave a live turn behind to receive another question.
      if (!active.terminal) this.dispose();
    }
  }
  dispose() { const child = this.child; this.child = null; this.fail(new Error('Codex 会话连接已关闭，原会话已保留')); if (child) terminateProcess(child); }
}
