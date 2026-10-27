import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { cliSystemInstructions, runProcess } from './codex-cli.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FINAL_STOPS = new Set(['end_turn', 'stop_sequence']);
const IDENTITY_ENV = Object.freeze(['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_AWS_WORKSPACE_ID', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'AWS_PROFILE', 'AWS_REGION',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST']);

function sessionError(message, code, details = {}) {
  return Object.assign(new Error(message), { code, accepted: false, uncertain: false, ...details });
}

function eventUuid(sessionId, eventId) {
  const hash = createHash('sha256').update(`${sessionId}:${eventId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function textOf(content) {
  return typeof content === 'string' ? content : (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

async function readIdentityJson(file, limit = 8_000_000) {
  try {
    if ((await stat(file)).size > limit) throw new Error();
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw sessionError('无法读取 Claude 连接身份配置，请检查原连接设置', 'CLAUDE_IDENTITY_UNAVAILABLE');
  }
}

function contentParts(input) {
  const parts = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
  if (!Array.isArray(parts) || !parts.length) throw sessionError('Claude 请求内容不能为空', 'CLAUDE_INPUT_INVALID');
  return parts.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    const image = part?.type === 'image' && part.source?.type === 'base64'
      ? `data:${part.source.media_type};base64,${part.source.data}` : part?.image_url?.url ?? part?.url;
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image ?? '');
    if (!match) throw sessionError('Claude 图片格式无效', 'CLAUDE_INPUT_INVALID');
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  });
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

/** Locate only this UUID's native transcript, without loading unrelated sessions. */
export async function claudeSessionTranscriptPath({ sessionId, cwd, env = process.env, configDir }) {
  if (!UUID.test(sessionId ?? '')) throw sessionError('Claude 会话 ID 无效', 'CLAUDE_SESSION_INVALID');
  const root = path.resolve(cwd, configDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(env.USERPROFILE ?? env.HOME ?? homedir(), '.claude'));
  const projects = path.join(root, 'projects');
  const encoded = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const override = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CODE_PROJECT_DIR_NAME : undefined;
  if (override && (path.basename(override) !== override || ['.', '..'].includes(override))) throw sessionError('Claude 会话目录设置无效', 'CLAUDE_SESSION_INVALID');
  const project = override ?? encoded;
  const direct = path.join(projects, project, `${sessionId}.jsonl`);
  if ((override || encoded.length <= 200) && await isFile(direct)) return direct;
  if (!override && encoded.length > 200) {
    let folders;
    try { folders = await readdir(projects, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const matches = [];
    for (const folder of folders) {
      if (!folder.isDirectory() || !folder.name.startsWith(encoded.slice(0, 200))) continue;
      const file = path.join(projects, folder.name, `${sessionId}.jsonl`);
      if (await isFile(file)) matches.push(file);
    }
    if (matches.length > 1) throw sessionError('发现重复的 Claude 会话文件，无法确定要恢复的记录', 'CLAUDE_SESSION_AMBIGUOUS');
    return matches[0] ?? null;
  }
  return null;
}

/** Native JSONL is read for receipts, never copied back into a model request. */
async function inspectTranscript(file, sessionId, eventId, start = 0) {
  if (!file) return { valid: false, accepted: false, complete: false };
  const marker = eventId ? `[Nekomate event:${eventId}]` : null;
  const expectedUuid = eventId ? eventUuid(sessionId, eventId) : null;
  let valid = false, accepted = false, complete = false, text = '', nativeTurnId, following = false;
  const ancestors = new Set();
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8', start }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch {
        throw sessionError('Claude 原生会话记录不完整，请勿创建新会话覆盖它', 'CLAUDE_SESSION_INVALID', { accepted, uncertain: true });
      }
      if (item.sessionId && item.sessionId !== sessionId) throw sessionError('Claude 原生会话记录与保存的 ID 不一致', 'CLAUDE_SESSION_MISMATCH', { uncertain: true });
      if (item.type === 'user' || item.type === 'assistant') valid = true;
      if (!marker) { if (valid) break; continue; }
      if (item.type === 'user' && (item.uuid === expectedUuid || textOf(item.message?.content).includes(marker))) {
        accepted = true; following = true; complete = false; text = ''; nativeTurnId = item.uuid;
        if (item.uuid) ancestors.add(item.uuid);
        continue;
      }
      if (!following || item.isSidechain || !['user', 'assistant'].includes(item.type)) continue;
      // Tool results can be user records. A later external prompt ends this turn.
      const content = item.message?.content;
      const toolResult = Array.isArray(content) && content.some(part => part.type === 'tool_result');
      if (item.type === 'user' && !toolResult) { following = false; continue; }
      if (item.parentUuid && ancestors.size && !ancestors.has(item.parentUuid)) continue;
      if (item.uuid) ancestors.add(item.uuid);
      if (item.type === 'assistant') {
        if (item.isApiErrorMessage || item.is_error || item.error) continue;
        const output = textOf(content);
        if (output) text += (text ? '\n' : '') + output;
        if (FINAL_STOPS.has(item.message?.stop_reason)) { complete = true; nativeTurnId = item.uuid ?? nativeTurnId; }
      }
    }
  } finally { lines.close(); }
  return { valid, accepted, complete: complete && Boolean(text.trim()), text, nativeTurnId };
}

/** A process may end between turns; the native conversation ID never changes. */
export class ClaudeSession {
  constructor({ launch, cwd, sessionId, create = false, state, pendingEventId = null, initialInstructions = '', onState = () => {}, runner = runProcess, configDir, transcriptPath } = {}) {
    if (!launch?.executable || !path.isAbsolute(cwd ?? '') || !UUID.test(sessionId ?? '')) throw sessionError('Claude 原生会话配置无效', 'CLAUDE_SESSION_INVALID');
    this.launch = launch; this.cwd = path.resolve(cwd); this.sessionId = sessionId.toLowerCase();
    this.allocated = state === 'allocated' || (create && !state); this.pendingEventId = pendingEventId;
    this.initialInstructions = initialInstructions; this.onState = onState; this.runner = runner;
    this.configDir = configDir; this.transcriptPath = transcriptPath; this.busy = false;
    this.state = state ?? (this.allocated ? 'allocated' : 'ready');
  }

  async #file() {
    if (this.transcriptPath) return await isFile(this.transcriptPath) ? this.transcriptPath : null;
    return claudeSessionTranscriptPath({ sessionId: this.sessionId, cwd: this.cwd, env: this.launch.env ?? process.env, configDir: this.configDir });
  }

  async #state(state, extra = {}) {
    this.state = state;
    await this.onState({ sessionId: this.sessionId, state, pendingEventId: this.pendingEventId, ...extra });
  }

  /** Hash only connection fields; never execute auth helpers or expose their credentials. */
  async identity() {
    const inherited = this.launch.env ?? process.env;
    const home = inherited.USERPROFILE ?? inherited.HOME ?? homedir();
    const configDirectory = path.resolve(this.cwd, this.configDir ?? inherited.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'));
    const settings = await readIdentityJson(path.join(configDirectory, 'settings.json'), 2_000_000) ?? {};
    const effective = { ...inherited };
    // Only user settings are enabled by our launch flags. Host-managed routing ignores their provider env.
    if (!inherited.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST && settings.env && typeof settings.env === 'object') {
      for (const key of IDENTITY_ENV) if (typeof settings.env[key] === 'string') effective[key] = settings.env[key];
    }
    const envIdentity = Object.fromEntries(IDENTITY_ENV.map(key => [key, effective[key] ?? '']));
    const customDirectory = Boolean(this.configDir ?? inherited.CLAUDE_CONFIG_DIR);
    const global = customDirectory
      ? await readIdentityJson(path.join(configDirectory, '.claude.json'))
      : await readIdentityJson(path.join(home, '.claude.json'));
    const saved = global?.oauthAccount;
    const account = saved && typeof saved === 'object' ? {
      accountUuid: saved.accountUuid ?? null, organizationUuid: saved.organizationUuid ?? null,
      emailAddress: saved.accountUuid ? null : saved.emailAddress ?? null,
    } : null;
    // Managed enterprise policy and an auth helper's dynamic output cannot be proven by this local fingerprint.
    const identity = { configDirectory, env: envIdentity, account, apiKeyHelper: settings.apiKeyHelper ?? null,
      forceLoginMethod: settings.forceLoginMethod ?? null, forceLoginOrgUUID: settings.forceLoginOrgUUID ?? null };
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  async validateResume() {
    const file = await this.#file();
    if (!file) {
      if (this.allocated && this.state === 'allocated' && !this.pendingEventId) return { sessionId: this.sessionId, state: 'allocated' };
      throw sessionError('找不到这段学习的 Claude 原生会话，无法恢复；没有创建新的会话', 'CLAUDE_SESSION_MISSING', { uncertain: Boolean(this.pendingEventId) });
    }
    const receipt = await inspectTranscript(file, this.sessionId, this.pendingEventId);
    if (!receipt.valid) throw sessionError('Claude 原生会话尚无可恢复的消息', 'CLAUDE_SESSION_INVALID', { uncertain: true });
    this.allocated = false;
    if (receipt.accepted) await this.#state('ready', { acceptedEventId: this.pendingEventId, nativeTurnId: receipt.nativeTurnId });
    return { sessionId: this.sessionId, state: this.state === 'allocated' ? 'ready' : this.state };
  }

  async run({ input, task = '', model, fastMode, allowWeb = false, signal, onDelta, eventId } = {}) {
    if (this.busy) throw sessionError('这段 Claude 学习会话正在处理上一条内容', 'CLAUDE_SESSION_BUSY');
    if (typeof eventId !== 'string' || !/^[a-zA-Z0-9._:-]{1,180}$/.test(eventId)) throw sessionError('缺少有效的学习事件 ID', 'CLAUDE_EVENT_INVALID');
    if (signal?.aborted) throw sessionError('请求已取消', 'CLAUDE_CANCELLED');
    this.busy = true;
    let accepted = false, result, streamed = '', assistantId, echoAccepted = false, receiptStart = 0, streamFailure;
    const wasAllocated = this.allocated;
    try {
      await this.validateResume();
      const previous = await inspectTranscript(await this.#file(), this.sessionId, eventId);
      accepted = previous.accepted;
      if (previous.accepted) {
        await this.#state('ready', { acceptedEventId: eventId, nativeTurnId: previous.nativeTurnId });
        if (previous.complete) return { text: previous.text, sessionId: this.sessionId, nativeTurnId: previous.nativeTurnId, accepted: true, replayed: true, usage: null, model: model || 'Claude Code' };
      }
      // An unknown prior submission must be reconciled by the caller, never replayed.
      if (!previous.accepted && this.pendingEventId === eventId) throw sessionError('上次请求是否被 Claude 保存尚不确定，未重复发送资料，请检查会话状态后再重试', 'CLAUDE_RECEIPT_UNKNOWN', { uncertain: true });
      const existingFile = await this.#file();
      if (existingFile) receiptStart = (await stat(existingFile)).size;
      const marker = `[Nekomate event:${eventId}]`;
      let parts = previous.accepted
        ? [{ type: 'text', text: `继续完成之前已收到的 ${marker}。原始资料已在本会话中，请直接沿用，不需要用户重复提供。` }]
        : contentParts(input);
      if (!previous.accepted && !textOf(parts).includes(marker)) parts = [{ type: 'text', text: marker }, ...parts];
      const userUuid = previous.accepted ? randomUUID() : eventUuid(this.sessionId, eventId);
      const stdin = JSON.stringify({ type: 'user', uuid: userUuid, session_id: this.sessionId, message: { role: 'user', content: parts }, parent_tool_use_id: null }) + '\n';
      if (Buffer.byteLength(stdin) > 10_000_000) throw sessionError('Claude 本次截图资料过大', 'CLAUDE_INPUT_TOO_LARGE');
      const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
        ...(this.allocated ? ['--session-id', this.sessionId] : ['--resume', this.sessionId]),
        '--tools', allowWeb ? 'WebSearch,WebFetch' : '', ...(allowWeb ? ['--allowedTools', 'WebSearch,WebFetch'] : []),
        '--disallowedTools', allowWeb ? 'Bash,Read,Write,Edit,Glob,Grep,Agent,Task,mcp__*' : '*', '--permission-mode', 'dontAsk',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--safe-mode', '--setting-sources', 'user',
        '--settings', JSON.stringify({ disableAllHooks: true, fastMode: fastMode === true || fastMode?.type === 'claude' }),
        '--system-prompt', cliSystemInstructions([this.initialInstructions, task].filter(Boolean).join('\n\n'), { allowWeb })];
      if (model) args.push('--model', model);
      let buffer = '', sawOutput = false;
      const consume = event => {
        if (event.session_id && event.session_id !== this.sessionId) throw sessionError('Claude 返回了另一段会话，已停止处理', 'CLAUDE_SESSION_MISMATCH', { uncertain: true });
        if (event.type === 'user' && (event.uuid === userUuid || textOf(event.message?.content).includes(marker))) echoAccepted = true;
        if (event.type === 'assistant' && !event.parent_tool_use_id) assistantId = event.uuid ?? assistantId;
        const delta = event.type === 'stream_event' && !event.parent_tool_use_id && event.event?.delta?.type === 'text_delta' ? event.event.delta.text : '';
        if (delta) { streamed += delta; if (streamed.length > 200_000) throw sessionError('Claude 回答过长', 'CLAUDE_OUTPUT_TOO_LARGE'); onDelta?.(delta); }
        if (event.type === 'result') result = event;
        if (event.type === 'error' || event.is_error || event.error || event.status === 'error') throw sessionError('Claude 未完成请求，请检查登录、网络与模型配置', 'CLAUDE_TURN_FAILED');
      };
      const stdout = chunk => {
        sawOutput = true;
        buffer += chunk;
        let end;
        try {
          while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (line) consume(JSON.parse(line));
          }
        } catch (error) { streamFailure = error; throw error; }
      };
      this.pendingEventId = eventId;
      // Persist before handing stdin to the child: an app crash must not permit blind replay.
      await this.#state('uncertain');
      const output = await this.runner(this.launch.executable, [...(this.launch.prefix ?? []), ...args], { cwd: this.cwd, env: this.launch.env, input: stdin, signal, onStdout: stdout });
      if (!sawOutput && output) stdout(output);
      if (buffer.trim()) consume(JSON.parse(buffer));
      const receipt = await inspectTranscript(await this.#file(), this.sessionId, eventId, receiptStart);
      accepted = receipt.accepted || echoAccepted;
      if (!receipt.accepted) throw sessionError('Claude 未能确认本次资料已保存到原生会话，未创建新会话', 'CLAUDE_PERSISTENCE_UNCONFIRMED', { accepted, uncertain: true });
      this.allocated = false;
      if (signal?.aborted) throw sessionError('请求已取消', 'CLAUDE_CANCELLED', { accepted: true });
      const text = result?.result || streamed;
      if (!result || typeof text !== 'string' || !text.trim()) throw sessionError('Claude 回答尚未完成，可在原会话中继续', 'CLAUDE_TURN_INCOMPLETE', { accepted: true });
      this.pendingEventId = null;
      await this.#state('ready', { acceptedEventId: eventId, nativeTurnId: assistantId ?? receipt.nativeTurnId });
      return { text, sessionId: this.sessionId, nativeTurnId: assistantId ?? receipt.nativeTurnId, accepted: true, usage: result.usage ?? null, model: model || 'Claude Code' };
    } catch (error) {
      error = streamFailure ?? error;
      let receipt;
      try { receipt = await inspectTranscript(await this.#file(), this.sessionId, eventId, receiptStart); } catch { /* Retain the original failure and uncertain state. */ }
      accepted ||= Boolean(receipt?.accepted || echoAccepted);
      if (receipt?.valid) this.allocated = false;
      if (accepted) await this.#state('ready', { acceptedEventId: eventId, nativeTurnId: receipt?.nativeTurnId ?? assistantId });
      else if (this.pendingEventId) await this.#state('uncertain');
      else if (wasAllocated) this.allocated = true;
      throw Object.assign(error, { accepted: accepted || Boolean(error.accepted), uncertain: Boolean(error.uncertain || (this.pendingEventId && !accepted)), sessionId: this.sessionId });
    } finally { this.busy = false; }
  }
}
