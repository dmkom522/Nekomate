import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveLocalCli, CLI_TYPES } from './local-cli.mjs';
import { terminateProcess } from './codex-cli.mjs';
import { supportsPurpose } from './model-capabilities.mjs';
import { codexAppServerArgs } from './codex-launch.mjs';
import { fastModeOption } from './fast-capabilities.mjs';

// Exclude explicitly unsupported entries; absent capability data is not proof of vision support.
export function catalogModels(entries, kind = 'codex') {
  const models = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!supportsPurpose(entry, 'vision', { cli: true })) continue;
    const id = entry.model ?? entry.id;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x1f]/.test(id)) continue;
    const label = typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.slice(0, 200) : id;
    const fastMode = fastModeOption(entry, { mode: 'cli', kind });
    models.set(id, { id, label, isDefault: entry.isDefault === true, ...(fastMode ? { fastMode } : {}) });
  }
  return [...models.values()];
}

async function cliCatalog(kind, launch, cwd, { spawnImpl = spawn, timeout = 20000, signal } = {}) {
  if (signal?.aborted) throw new Error('请求已取消');
  const args = kind === 'codex'
    ? codexAppServerArgs()
    : ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--disallowedTools', '*', '--safe-mode', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(launch.executable, [...launch.prefix, ...args], { cwd, env: launch.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', size = 0, page = 0, nextId = 1, expected = 0, result, failure, stopTimer;
    const entries = [], cursors = new Set();
    const fail = message => { if (failure || result) return; failure = new Error(message); terminateProcess(child); };
    const timer = setTimeout(() => fail('读取模型超时，请检查 CLI 连接后重试'), timeout);
    const abort = () => fail('请求已取消');
    signal?.addEventListener('abort', abort, { once: true });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const done = rows => {
      result = { models: catalogModels(rows, kind), source: 'cli' };
      clearTimeout(timer); child.stdin.end();
      stopTimer = setTimeout(() => terminateProcess(child), 500);
    };
    const request = cursor => { expected = nextId++; send({ id: expected, method: 'model/list', params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } }); };
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdin.on('error', () => fail('无法读取 CLI 模型列表'));
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法启动 CLI，请检查路径')); });
    child.on('close', () => {
      clearTimeout(timer); clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new Error('CLI 未返回模型列表，请检查版本与连接'));
    });
    child.stdout.on('data', chunk => {
      if (failure || result) return;
      size += Buffer.byteLength(chunk); buffer += chunk;
      if (size > 2_000_000) return fail('CLI 模型列表过大');
      while (buffer.includes('\n') && !failure && !result) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('CLI 模型列表格式不兼容'); break; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { fail('CLI 模型列表格式不兼容'); break; }
        if (message.method) {
          if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Model discovery does not provide tools' } });
          continue;
        }
        if (kind === 'claude') {
          if (message.type === 'control_request') { fail('CLI 模型检测不允许工具操作'); break; }
          if (message.type !== 'control_response' || message.response?.request_id !== 'deskmate-models') continue;
          const response = message.response;
          if (response.subtype !== 'success' || !Array.isArray(response.response?.models)) { fail('CLI 未提供模型列表，请检查登录和版本'); break; }
          done(response.response.models.filter(m => m && typeof m === 'object').map(m => ({ ...m, model: m.value, displayName: m.displayName })));
          continue;
        }
        if (message.id !== expected) continue;
        if (message.error) { fail('CLI 无法读取模型列表，请检查版本与连接'); break; }
        if (expected === 0) {
          send({ method: 'initialized', params: {} }); request();
        } else {
          const data = message.result;
          if (!Array.isArray(data?.data)) { fail('CLI 模型列表格式不兼容'); break; }
          entries.push(...data.data);
          if (data.nextCursor) {
            if (++page >= 10 || cursors.has(data.nextCursor)) { fail('CLI 模型列表分页异常'); break; }
            cursors.add(data.nextCursor); request(data.nextCursor);
          } else {
            done(entries);
          }
        }
      }
    });
    if (kind === 'claude') send({ type: 'control_request', request_id: 'deskmate-models', request: { subtype: 'initialize', hooks: {} } });
    else send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'nekomate', title: 'Nekomate', version: '0.1.0' } } });
    if (signal?.aborted) abort();
  });
}

export async function listCliModels(config, { resolver = resolveLocalCli, ...options } = {}) {
  if (!Object.hasOwn(CLI_TYPES, config?.kind)) throw new Error('不支持的 CLI 类型');
  const launch = await resolver(config);
  const root = path.resolve(tmpdir()), folder = await mkdtemp(path.join(root, 'deskmate-models-'));
  try { return await cliCatalog(config.kind, launch, folder, options); }
  finally { if (path.dirname(folder) === root && path.basename(folder).startsWith('deskmate-models-')) await rm(folder, { recursive: true, force: true, maxRetries: 3 }); }
}
