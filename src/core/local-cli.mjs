import { access, stat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runProcess, cliSystemInstructions } from './codex-cli.mjs';
import { rpcAnswer } from './cli-stream.mjs';
import { jsonLines } from './streaming.mjs';
import { cliEnvironment } from './cli-environment.mjs';
import { normalizeCliPath, cliSearchPaths, withSearchPath } from './cli-paths.mjs';
import { codexAppServerArgs } from './codex-launch.mjs';

export const CLI_TYPES = Object.freeze({
  codex: { label: 'Codex CLI', npm: '@openai/codex' },
  claude: { label: 'Claude Code', npm: '@anthropic-ai/claude-code' },
});

export function validateLocalPath(value = '', env = process.env) {
  const file = normalizeCliPath(value, env);
  if (!file) return '';
  if (file.length > 4096 || /[\x00-\x1f]/.test(file) || !path.isAbsolute(file)) throw new Error('请填写可执行文件的完整本机路径，不要填写命令或参数');
  if (process.platform === 'win32' && !/\.(exe|cmd)$/i.test(file)) throw new Error('Windows 请使用 .exe 或 npm 安装生成的 .cmd 路径');
  return file;
}

export async function resolveLocalCli(config, env = process.env) {
  const kind = config.kind ?? 'codex', type = CLI_TYPES[kind];
  if (!type) throw new Error('不支持的 CLI 类型');
  const dirs = cliSearchPaths(kind, env);
  const environment = withSearchPath(await cliEnvironment(kind, env), dirs);
  const supplied = validateLocalPath(config.path, env);
  const candidates = supplied ? [supplied] : dirs.flatMap(dir => process.platform === 'win32' ? [path.join(dir, `${kind}.exe`), path.join(dir, `${kind}.cmd`)] : [path.join(dir, kind)]);
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (/\.cmd$/i.test(candidate)) {
        // Resolve the documented npm package entry. Never execute or parse arbitrary shell code.
        if (!type.npm || path.basename(candidate).toLowerCase() !== `${kind}.cmd`) throw new Error('仅支持该 CLI 的标准 npm 启动文件');
        const packageDir = path.join(path.dirname(candidate), 'node_modules', type.npm);
        const pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[kind];
        if (pkg.name !== type.npm || !bin) throw new Error('npm CLI 安装不完整');
        const entry = path.resolve(packageDir, bin);
        if (!entry.startsWith(path.resolve(packageDir) + path.sep) || !(await stat(entry)).isFile()) throw new Error('npm CLI 入口无效');
        for (const dir of [path.dirname(candidate), ...dirs]) {
          const node = path.join(dir, 'node.exe');
          try { if ((await stat(node)).isFile()) return { executable: node, prefix: [entry], path: path.resolve(candidate), env: environment }; } catch { /* Continue. */ }
        }
        throw new Error('npm CLI 需要 Node.js，请将 node.exe 加入 PATH');
      }
      await access(candidate, constants.X_OK);
      return { executable: path.resolve(candidate), prefix: [], path: path.resolve(candidate), env: environment };
    } catch (error) { if (supplied && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(supplied ? '找不到该 CLI 程序，请检查路径' : `未找到 ${type.label}，请安装后登录，或选择本机路径`);
}

export async function inspectLocalCli(config) {
  const launch = await resolveLocalCli(config);
  const version = (await runProcess(launch.executable, [...launch.prefix, '--version'], { timeout: 10000, env: launch.env })).trim();
  if (!/\d+\.\d+/.test(version)) throw new Error('程序没有返回有效版本');
  const help = await runProcess(launch.executable, [...launch.prefix, ...(config.kind === 'codex' ? ['app-server'] : []), '--help'], { timeout: 10000, env: launch.env });
  const flags = config.kind === 'codex' ? ['--listen'] : ['--input-format', '--output-format'];
  if (flags.some(flag => !help.includes(flag))) throw new Error('CLI 版本不兼容，请更新所选程序');
  return { path: launch.path, version: version.slice(0, 150) };
}

function flatten(messages) {
  const content = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    content.push({ type: 'text', text: `[${message.role}]` });
    content.push(...(typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content));
  }
  return content;
}

export async function localCliChat(config, messages, signal, { runner = runProcess, resolver = resolveLocalCli, onDelta, rpcOptions, allowWeb = false, fastMode = null } = {}) {
  if (!Object.hasOwn(CLI_TYPES, config?.kind)) throw new Error('不支持的 CLI 类型');
  const launch = await resolver(config);
  const run = (exe, args, options) => runner(exe, [...launch.prefix, ...args], { ...options, env: launch.env });
  const tempRoot = path.resolve(tmpdir()), folder = await mkdtemp(path.join(tempRoot, 'deskmate-cli-'));
  try {
    const content = flatten(messages), args = [], system = cliSystemInstructions(messages, { allowWeb });
    let input;
    if (config.kind === 'codex') {
      args.push(...codexAppServerArgs({ allowWeb, fastMode: fastMode?.type === 'codex' }));
      const parts = content.map(part => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', url: part.image_url.url });
      return await rpcAnswer('codex', launch, args, folder, parts, config.model, signal, onDelta ?? (() => {}), { ...rpcOptions, systemInstructions: system, allowWeb, serviceTier: fastMode?.type === 'codex' ? fastMode.tier : 'default' });
    } else if (config.kind === 'claude') {
      args.push('--print', '--input-format', 'stream-json', '--output-format', 'json', '--tools', allowWeb ? 'WebSearch,WebFetch' : '', ...(allowWeb ? ['--allowedTools', 'WebSearch,WebFetch'] : []), '--disallowedTools', allowWeb ? 'Bash,Read,Write,Edit,Glob,Grep,Agent,Task,mcp__*' : '*', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--safe-mode', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--no-session-persistence', '--system-prompt', system);
      args[args.indexOf('--settings') + 1] = JSON.stringify({ disableAllHooks: true, fastMode: fastMode?.type === 'claude' });
      const parts = content.map(part => {
        if (part.type === 'text') return part;
        const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url?.url ?? '');
        if (!match) throw new Error('CLI 图片格式无效');
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
      });
      input = JSON.stringify({ type: 'user', message: { role: 'user', content: parts } }) + '\n';
      if (onDelta) { args[args.indexOf('--output-format') + 1] = 'stream-json'; args.push('--verbose', '--include-partial-messages'); }
    } else throw new Error('不支持的 CLI 类型');
    if (config.model) args.push('--model', config.model);
    let streamed = '', finalResult, streamFinished = false;
    const onStdout = onDelta && jsonLines(event => {
      if (event.type === 'error' || event.is_error || event.error || event.status === 'error') throw new Error();
      const delta = event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' ? event.event.delta.text : '';
      if (delta) { streamed += delta; if (streamed.length > 64000) throw new Error(); onDelta(delta); }
      if (event.type === 'result') { finalResult = event.result; streamFinished = true; }
    });
    const output = await run(launch.executable, args, { cwd: folder, input, signal, onStdout });
    if (signal?.aborted) throw new Error('请求已取消');
    if (onDelta) {
      const text = finalResult || streamed;
      if (!streamFinished || !text?.trim()) throw new Error('CLI 流式回答未完成');
      return { text, usage: null, model: config.model || CLI_TYPES[config.kind].label };
    }
    let text;
    try {
      const result = JSON.parse(output);
      if (result.is_error || result.error) throw new Error('CLI 未完成请求');
      text = result.result;
    } catch { throw new Error('CLI 没有返回可用的回答，请检查版本、登录与模型配置'); }
    if (typeof text !== 'string' || !text.trim()) throw new Error('CLI 未返回文字回答');
    return { text, usage: null, model: config.model || CLI_TYPES[config.kind].label };
  } finally {
    if (path.dirname(folder) === tempRoot && path.basename(folder).startsWith('deskmate-cli-')) await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}
