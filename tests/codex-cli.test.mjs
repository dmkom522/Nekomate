import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { codexChat, runProcess, validateCliPath, resolveCodexPath } from '../src/core/codex-cli.mjs';
import { NEKOMATE_SYSTEM_PROMPT } from '../src/core/prompts.mjs';

const fixture = path.resolve('tests/fixtures/codex.mjs');
const resolvePath = async () => process.execPath;
let lastFolder;
const runner = (executable, args, options) => {
  lastFolder = options.cwd;
  return runProcess(executable, args, { ...options, spawnImpl: (file, cliArgs, settings) => {
    assert.equal(settings.shell, false); assert.equal(settings.windowsHide, true);
    return spawn(file, [fixture, ...cliArgs], settings);
  } });
};

test('CLI receives literal stdin, actual image bytes, safe flags, and returns the final file; temp files are removed', async () => {
  const result = await codexChat({ path: '', model: 'chosen-model' }, [{ role: 'system', content: '老师' }, { role: 'user', content: [{ type: 'text', text: '解释矩阵 $(not-a-command) & <script>' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }] }], null, { runner, resolvePath });
  const data = JSON.parse(result.text);
  assert.match(data.prompt, /解释矩阵 \$\(not-a-command\) & <script>/);
  assert.equal(data.image, '/9j/2Q==');
  assert.ok(data.args.includes('--ignore-user-config'));
  assert.ok(data.args.includes('--ephemeral'));
  assert.ok(data.args.includes('read-only'));
  assert.ok(data.args.includes('web_search="disabled"'));
  assert.ok(data.args.includes('shell_tool'));
  assert.ok(data.args.includes('chosen-model'));
  const system = JSON.parse(data.args.find(arg => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  assert.ok(system.includes('老师')); assert.ok(system.includes('不操作电脑')); assert.ok(system.includes('不访问其他文件'));
  assert.equal(data.prompt.includes('老师'), false); assert.equal(data.prompt.includes('[system]'), false);
  await assert.rejects(access(data.cwd));
});

test('legacy Codex exec uses the global developer-instructions fallback and keeps user text literal', async () => {
  const result = await codexChat({ path: '' }, [{ role: 'user', content: 'USER_ONLY_QUESTION' }], null, { runner, resolvePath });
  const data = JSON.parse(result.text);
  const system = JSON.parse(data.args.find(arg => arg.startsWith('developer_instructions=')).slice('developer_instructions='.length));
  assert.ok(system.includes(NEKOMATE_SYSTEM_PROMPT)); assert.equal(system.includes('USER_ONLY_QUESTION'), false);
  assert.equal(data.prompt.includes(NEKOMATE_SYSTEM_PROMPT), false); assert.ok(data.prompt.includes('USER_ONLY_QUESTION'));
});

test('CLI cancellation terminates an actual child and cleans its temporary directory', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(codexChat({ path: '' }, [{ role: 'user', content: 'WAIT_FOR_CANCEL' }], controller.signal, { runner, resolvePath }), /取消/);
    await assert.rejects(access(lastFolder));
  } finally { clearTimeout(timer); }
});

test('CLI errors and timeouts do not return successful empty answers', async () => {
  await assert.rejects(codexChat({ path: '' }, [{ role: 'user', content: 'FAIL_PROCESS' }], null, { runner, resolvePath }), /退出/);
  await assert.rejects(access(lastFolder));
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /超时/);
});

test('CLI paths reject shell commands and batch wrappers, and detect a real native executable', async () => {
  assert.throws(() => validateCliPath('codex --yolo'), /完整/);
  if (process.platform === 'win32') assert.throws(() => validateCliPath('C:\\tools\\codex.cmd'), /原生/);
  assert.equal(await resolveCodexPath(process.execPath), process.execPath);
  await assert.rejects(resolveCodexPath('', { PATH: '' }), /PATH/);
});

test('process output preserves Chinese when a character spans stdout chunks', async () => {
  const result = await runProcess(process.execPath, ['-e', 'const b=Buffer.from("课程矩阵");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)']);
  assert.equal(result, '课程矩阵');
});
