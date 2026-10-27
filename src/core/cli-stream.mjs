import { spawn } from 'node:child_process';
import { terminateProcess, cliSystemInstructions } from './codex-cli.mjs';
import { jsonLines } from './streaming.mjs';

// Codex app-server delivers token events through its bidirectional transport.
export function rpcAnswer(kind, launch, args, cwd, content, model, signal, onDelta, { spawnImpl = spawn, timeout = 120000, handshakeTimeout = 20000, systemInstructions, onWebSearch, allowWeb = false, serviceTier = 'default' } = {}) {
  return new Promise((resolve, reject) => {
    if (kind !== 'codex') return reject(new Error('不支持的 CLI 类型'));
    if (signal?.aborted) return reject(new Error('请求已取消'));
    const child = spawnImpl(launch.executable, [...launch.prefix, ...args], { cwd, env: launch.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', bytes = 0, failure, finished = false, killTimer, thread, timer;
    const itemText = new Map();
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const stop = error => { if (failure || finished) return; failure = error; terminateProcess(child); };
    const abort = () => stop(new Error('请求已取消'));
    const deadline = (message, ms) => { clearTimeout(timer); timer = setTimeout(() => stop(new Error(message)), ms); };
    deadline('CLI 初始化超时，请检查程序版本与连接', handshakeTimeout);
    signal?.addEventListener('abort', abort, { once: true });
    const done = () => { finished = true; clearTimeout(timer); child.stdin.end(); killTimer = setTimeout(() => terminateProcess(child), 500); };
    const emit = delta => { if (typeof delta !== 'string' || !delta) return; text += delta; if (text.length > 64000) throw new Error(); onDelta(delta); };
    child.stdout.setEncoding('utf8'); child.stderr.resume();
    child.stdin.on('error', () => stop(new Error('CLI 连接已关闭')));
    child.on('error', () => stop(new Error('无法启动 CLI')));
    child.on('close', () => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (!finished || !text.trim()) reject(new Error('CLI 未完成回答，请检查版本与登录'));
      else resolve({ text, usage: null, model: model || kind });
    });
    const parse = jsonLines(message => {
      if (message.method && message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: 'Local tools and interactive approvals are unavailable' } });
        stop(new Error('当前课程任务不支持本机工具操作')); return;
      }
      if (message.error) { stop(new Error('CLI 请求失败，请检查登录、版本和模型')); return; }
      if (message.id === 0) {
        deadline('CLI 创建会话超时，请检查登录与连接', handshakeTimeout);
        send({ method: 'initialized', params: {} });
        send({ id: 1, method: 'thread/start', params: { cwd, model: model || undefined, serviceTier, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: cliSystemInstructions(systemInstructions, { allowWeb }), config: { mcp_servers: {}, project_doc_max_bytes: 0, web_search: allowWeb ? 'live' : 'disabled' } } });
      } else if (message.id === 1) {
        thread = message.result?.thread?.id;
        if (!thread) throw new Error();
        deadline('CLI 回答超时，请检查网络或稍后重试', timeout);
        send({ id: 2, method: 'turn/start', params: { threadId: thread, serviceTier, input: content, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } } });
      } else if (['item/started', 'item/completed'].includes(message.method) && message.params?.threadId === thread && message.params.item?.type === 'webSearch') {
        onWebSearch?.({ event: message.method, ...message.params.item });
      } else if (message.method === 'item/agentMessage/delta' && message.params?.threadId === thread) {
        const key = message.params.itemId ?? 'answer';
        itemText.set(key, (itemText.get(key) ?? '') + message.params.delta);
        emit(message.params.delta);
      } else if (message.method === 'item/completed' && message.params?.threadId === thread && message.params.item?.type === 'agentMessage') {
        const item = message.params.item, key = item.id ?? 'answer';
        const previous = itemText.get(key) ?? itemText.get('answer') ?? '';
        if (typeof item.text === 'string' && item.text.startsWith(previous)) {
          emit(item.text.slice(previous.length));
          if (key !== 'answer') itemText.delete('answer');
          itemText.set(key, item.text);
        }
      } else if (message.method === 'error' && message.params?.threadId === thread && !message.params.willRetry) {
        const code = message.params.error?.codexErrorInfo;
        const reason = { usageLimitExceeded: 'CLI 额度已用尽，请检查账户额度', contextWindowExceeded: 'CLI 上下文已满，请开始新的学习', unauthorized: 'CLI 登录已失效，请重新登录', httpConnectionFailed: 'CLI 连接失败，请检查网络或代理', responseStreamConnectionFailed: 'CLI 响应连接中断，请检查网络或代理' }[typeof code === 'string' ? code : Object.keys(code ?? {})[0]];
        stop(new Error(reason || 'CLI 返回错误，请检查账户、模型与连接'));
      } else if (message.method === 'turn/completed' && message.params?.threadId === thread) {
        if (message.params.turn?.status !== 'completed') stop(new Error('CLI 回答未完成')); else done();
      }
    });
    child.stdout.on('data', chunk => {
      if (failure || finished) return;
      bytes += Buffer.byteLength(chunk);
      try { if (bytes > 2_000_000) throw new Error(); parse(chunk); }
      catch { stop(new Error('CLI 流式响应格式不兼容')); }
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'nekomate', version: '0.1.0' } } });
    if (signal?.aborted) abort();
  });
}
