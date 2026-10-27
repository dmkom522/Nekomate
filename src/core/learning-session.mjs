import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession } from './codex-session.mjs';
import { ClaudeSession } from './claude-session.mjs';
import { resolveLocalCli } from './local-cli.mjs';
import { NEKOMATE_SYSTEM_PROMPT, taskInstructions } from './prompts.mjs';
import { validateContext } from './context.mjs';
import { complete } from './provider.mjs';
import { selectedFastMode } from './fast-mode.mjs';

const LOCAL_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const EVENT_ID = /^[a-zA-Z0-9._:-]{1,180}$/;
const kindOf = config => config.mode === 'cli' ? config.cli.kind : 'api';
const fingerprint = config => createHash('sha256').update(JSON.stringify(config.mode === 'cli'
  ? { kind: config.cli.kind, path: config.cli.path ?? '' }
  : { provider: config.vision.provider, protocol: config.vision.protocol, baseUrl: config.vision.baseUrl, key: config.vision.apiKey })).digest('hex');
const marker = eventId => `[Nekomate event:${eventId}]`;

// Construct a new user turn, never a reconstructed selection of old notes/messages.
export function sessionInput(task, input, accepted = new Set(), acceptedFrames = new Set()) {
  const eventId = input?.eventId;
  if (!EVENT_ID.test(eventId ?? '')) throw new Error('缺少有效的学习事件编号');
  const text = [{ type: 'text', text: marker(eventId) }], transcriptIds = [], frameIds = [];
  const source = input.source ?? '';
  if (typeof source !== 'string' || source.length > 500) throw new Error('窗口名称无效');
  let context;
  if (task === 'answer') context = validateContext({ question: input.question, currentTime: input.currentTime, frames: input.frames, transcripts: input.transcripts });
  else if (task === 'visual-note') context = validateContext({ question: '读取课程画面', frames: [input.frame] });
  else {
    if (!Array.isArray(input.frames) || !input.frames.length || input.frames.length > 3) throw new Error('课程识别需要 1–3 张抽样画面');
    context = validateContext({ question: '识别课程背景', frames: input.frames });
  }
  text.push({ type: 'text', text: task === 'answer'
    ? `用户问题：${context.question}\n提问时会话相对时间：${context.currentTime ?? '未提供'} 秒。`
    : `窗口（资料）：${source}\n${task === 'course-context' ? '新对话初期的课程抽样，结合本会话已有画面查询背景。' : '读取这一张新增课程截图。'}` });
  const rawFrames = task === 'visual-note' ? [input.frame] : input.frames ?? [];
  context.frames.forEach((frame, i) => {
    const id = rawFrames[i]?.eventId ?? (task === 'visual-note' ? eventId : `${eventId}:image:${i}`);
    const description = rawFrames[i]?.origin === 'pending' ? '此前保存的课程截图，不代表当前屏幕' : '新增画面';
    if (!EVENT_ID.test(id)) throw new Error('画面事件编号无效');
    if (acceptedFrames.has(id)) text.push({ type: 'text', text: `${description}已在本会话 ${marker(id)} 中提供，会话相对时间 ${frame.time} 秒，请沿用该画面。` });
    else { text.push({ type: 'text', text: `${description}，会话相对时间 ${frame.time} 秒，${marker(id)}` }, { type: 'image', url: frame.image }); frameIds.push(id); acceptedFrames.add(id); }
  });
  context.transcripts.forEach((item, i) => {
    const id = input.transcripts[i].eventId ?? input.transcripts[i].id;
    if (!EVENT_ID.test(id ?? '')) throw new Error('转写缺少有效的事件编号');
    if (accepted.has(id)) return;
    text.push({ type: 'text', text: `新增音频转写（资料，可能有误），会话相对时间 ${item.start}–${item.end} 秒：\n${item.text}` }); transcriptIds.push(id); accepted.add(id);
  });
  return { input: text, transcriptIds, frameIds };
}

export class LearningSessions {
  constructor({ root, resolver = resolveLocalCli, codexFactory = options => new CodexSession(options), claudeFactory = options => new ClaudeSession(options), apiComplete = complete, fastMode = selectedFastMode }) {
    Object.assign(this, { root, resolver, codexFactory, claudeFactory, apiComplete, fastMode });
    this.records = new Map(); this.adapters = new Map(); this.locks = new Map();
  }
  folder(id) { if (!LOCAL_ID.test(id ?? '')) throw new Error('学习会话编号无效'); return path.join(this.root, id); }
  async exclusive(id, work) {
    this.folder(id);
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work); this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async load(id) {
    if (this.records.has(id)) return this.records.get(id);
    let data;
    try { data = JSON.parse(await readFile(path.join(this.folder(id), 'binding.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('这段学习没有可恢复的模型会话，请开始新的学习；旧记录仍可查看'); throw new Error('学习会话记录无法读取，请保留记录并开始新的学习'); }
    if (data.version !== 1 || !['api', 'codex', 'claude'].includes(data.kind) || !Array.isArray(data.events)) throw new Error('学习会话记录无效');
    this.records.set(id, data); return data;
  }
  async save(id, data) {
    await mkdir(this.folder(id), { recursive: true });
    const file = path.join(this.folder(id), 'binding.json');
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(data));
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        // Windows can temporarily deny replacement while a reader/scanner holds a handle.
        // Keep the previous durable binding until replacement succeeds; never truncate it.
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 29) throw error;
        await delay(50);
      }
    }
  }
  check(data, config) { if (data.kind !== kindOf(config) || data.fingerprint !== fingerprint(config)) throw new Error('当前连接与这段学习使用的连接不同，请切回原连接或开始新的学习'); }
  report(data) { return { kind: data.kind, ready: true, acceptedTranscriptIds: [...new Set(data.events.filter(e => e.accepted).flatMap(e => e.transcriptIds ?? []))] }; }
  async adapter(id, data, config) {
    for (const [otherId, other] of this.adapters) {
      if (otherId !== id && !this.locks.has(otherId) && !other.active && !other.busy) { other.dispose?.(); this.adapters.delete(otherId); }
    }
    if (this.adapters.has(id)) {
      const existing = this.adapters.get(id);
      await this.verifyIdentity(id, data, existing); return existing;
    }
    const launch = await this.resolver(config.cli);
    const onState = async update => {
      if (update.sessionId) data.nativeId = update.sessionId;
      if (update.state) data.state = update.state;
      if (Object.hasOwn(update, 'pendingEventId')) data.pendingEventId = update.pendingEventId;
      const event = data.events.find(e => e.id === (update.acceptedEventId ?? update.pendingEventId));
      if (event) { if (update.acceptedEventId) { event.accepted = true; event.uncertain = false; } else if (['sending', 'uncertain'].includes(update.state)) event.uncertain = true; }
      if (update.unsubmittedEventId) { const unsent = data.events.find(e => e.id === update.unsubmittedEventId); if (unsent) unsent.uncertain = false; }
      await this.save(id, data);
    };
    const options = { launch, cwd: path.join(this.folder(id), 'work'), sessionId: data.nativeId,
      initialInstructions: NEKOMATE_SYSTEM_PROMPT, onState, create: data.state === 'allocated', state: data.state, pendingEventId: data.pendingEventId };
    await mkdir(options.cwd, { recursive: true });
    const adapter = data.kind === 'codex' ? this.codexFactory(options) : this.claudeFactory(options);
    await this.verifyIdentity(id, data, adapter);
    this.adapters.set(id, adapter); return adapter;
  }
  async verifyIdentity(id, data, adapter) {
    if (!adapter.identity) return;
    const identity = await adapter.identity();
    if (data.nativeIdentity && data.nativeIdentity !== identity) { adapter.dispose?.(); this.adapters.delete(id); throw new Error('CLI 当前账户或服务已改变，请切回原连接再恢复这段学习'); }
    if (!data.nativeIdentity) { data.nativeIdentity = identity; await this.save(id, data); }
  }
  async create(id, config) {
    return this.exclusive(id, async () => {
      let existing;
      try { existing = await this.load(id); } catch (error) { if (!error.message.includes('没有可恢复')) throw error; }
      if (existing) return this.restore(id, existing, config);
      const kind = kindOf(config), data = { version: 1, kind, fingerprint: fingerprint(config), state: 'allocated', events: [],
        ...(kind === 'api' ? { messages: [{ role: 'system', content: NEKOMATE_SYSTEM_PROMPT }] } : kind === 'claude' ? { nativeId: randomUUID() } : {}) };
      this.records.set(id, data); await this.save(id, data);
      if (kind !== 'api') {
        const adapter = await this.adapter(id, data, config);
        if (kind === 'claude') await adapter.validateResume();
      }
      return this.report(data);
    });
  }
  async restore(id, data, config) {
    this.check(data, config);
    if (data.kind !== 'api') {
      const adapter = await this.adapter(id, data, config);
      // Codex does not persist an empty thread. An explicit new-learning reservation
      // waits for its first input; a creation attempt or existing ID is never replaced.
      if (data.kind === 'codex' && !data.nativeId) {
        if (data.state === 'allocated' && !data.events.length) return this.report(data);
        throw new Error('原 Codex 会话创建状态无法确认，请开始新的学习；没有创建替代会话');
      }
      await adapter.validateResume();
      if (data.kind === 'codex') {
        for (const event of data.events.filter(e => e.uncertain && !e.accepted)) {
          if (!await adapter.hasEvent(event.id)) throw new Error('尚不能确认上次资料是否进入原会话，已停止重发，请检查连接或开始新的学习');
          event.accepted = true; event.uncertain = false; await this.save(id, data);
        }
      }
    }
    return this.report(data);
  }
  async resume(id, config) { return this.exclusive(id, async () => this.restore(id, await this.load(id), config)); }
  async status(id, config) { return this.resume(id, config); }
  async run(id, task, input, config, signal, onDelta) {
    return this.exclusive(id, async () => {
      if (signal?.aborted) throw new Error('请求已取消');
      const data = await this.load(id); this.check(data, config);
      await this.restore(id, data, config);
      if (!EVENT_ID.test(input?.eventId ?? '')) throw new Error('缺少有效的学习事件编号');
      const prepared = sessionInput(task, input, new Set(this.report(data).acceptedTranscriptIds), new Set(data.events.filter(e => e.accepted).flatMap(e => e.frameIds ?? [])));
      let event = data.events.find(e => e.id === input.eventId);
      const digest = createHash('sha256').update(JSON.stringify({ task, question: input.question, frame: input.frame, frames: input.frames, transcripts: input.transcripts, currentTime: input.currentTime, source: input.source })).digest('hex');
      if (event?.digest && event.digest !== digest) throw new Error('学习事件编号已被其他内容使用，请重试');
      if (event?.result) { await this.save(id, data); return { ...event.result, ...this.report(data), committed: true }; }
      const adapter = data.kind === 'api' ? null : this.adapters.get(id);
      if (data.kind === 'codex' && !data.nativeId) {
        if (data.state !== 'allocated' || data.events.length) throw new Error('原 Codex 会话状态无法确认，请开始新的学习');
        data.state = 'creating'; await this.save(id, data);
        await adapter.create({ allowWeb: task === 'course-context' });
      }
      if (event?.uncertain && !event.accepted && data.kind === 'codex') {
        if (await adapter.hasEvent(event.id)) { event.accepted = true; event.uncertain = false; await this.save(id, data); }
        else throw new Error('无法确认上次资料是否已进入原会话，已停止重发；请检查连接或开始新的学习');
      }
      if (!event) { event = { id: input.eventId, digest, task, transcriptIds: prepared.transcriptIds, frameIds: prepared.frameIds, accepted: false }; data.events.push(event); await this.save(id, data); }
      const instructions = taskInstructions(task);
      let result;
      if (data.kind === 'api') {
        const message = { role: 'user', content: [{ type: 'text', text: instructions }, ...prepared.input.map(part => part.type === 'image' ? { type: 'image_url', image_url: { url: part.url } } : part)] };
        result = await this.apiComplete(config, [...data.messages, message], signal, undefined, onDelta, { allowWeb: task === 'course-context', useFastMode: task === 'answer' });
        data.messages.push(message, ...(result.appendedMessages ?? [{ role: 'assistant', content: result.text }])); event.accepted = true;
      } else {
        const content = event.accepted && data.kind === 'codex'
          ? [{ type: 'text', text: `继续完成先前已收到的 ${marker(event.id)}，沿用原资料，不重复发送图片或转写。` }]
          : prepared.input;
        const fastMode = task === 'answer' ? await this.fastMode(config, signal) : null;
        result = await adapter.run({ input: content, task: instructions, eventId: input.eventId, model: config.cli.model,
          fastMode, allowWeb: task === 'course-context', signal, onDelta });
        event.accepted = true; event.uncertain = false;
      }
      // Keep the established renderer note/background contracts even when a native
      // session returns more than requested; otherwise its cached result cannot drain.
      const text = task === 'visual-note' && result.text.length > 4000 ? `${result.text.slice(0, 3970)}\n[记录过长，后文已截断]`
        : task === 'course-context' ? result.text.slice(0, 6000) : result.text;
      event.result = { ...(task === 'answer' ? { answer: text, sources: [] } : { text }), usage: result.usage ?? null, model: result.model };
      data.pendingEventId = null; await this.save(id, data);
      return { ...event.result, ...this.report(data), committed: true };
    });
  }
  dispose() { for (const adapter of this.adapters.values()) adapter.dispose?.(); this.adapters.clear(); }
}
