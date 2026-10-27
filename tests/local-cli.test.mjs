import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CLI_TYPES, localCliChat, resolveLocalCli } from '../src/core/local-cli.mjs';
import { normalizeConfig, publicConfig } from '../src/core/provider.mjs';
import { NEKOMATE_SYSTEM_PROMPT } from '../src/core/prompts.mjs';
const fixture = path.resolve('tests/fixtures/local-cli.mjs');
const content = [{ type: 'text', text: '解释矩阵 $(not-command) @private.txt' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/2Q==' } }];
const resolver = async config => ({ executable: process.execPath, prefix: [fixture, config.kind] });

for (const kind of ['claude']) {
  test(`${kind}: child process receives picture bytes and text, result is decoded, temporary data is removed`, async () => {
    const response = await localCliChat({ kind, path: '', model: 'test-model' }, [{ role: 'system', content: '课程资料' }, { role: 'user', content }], null, { resolver });
    const data = JSON.parse(response.text);
    assert.deepEqual(data.images, ['/9j/2Q==']);
    assert.ok(data.input.includes('解释矩阵 $(not-command)'));
    const system = data.args[data.args.indexOf('--system-prompt') + 1];
    assert.ok(system.includes('课程资料'));
    assert.ok(system.includes('不操作电脑'));
    assert.ok(system.includes('不执行命令'));
    assert.ok(system.includes('不访问其他文件'));
    assert.equal(data.input.includes('课程资料'), false);
    assert.equal(data.input.includes('[system]'), false);
    assert.ok(data.args.includes('test-model'));
    assert.equal(data.args[data.args.indexOf('--tools') + 1], '');
    assert.equal(data.args.includes('--allowedTools'), false);
    assert.equal(data.args[data.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(data.args[data.args.indexOf('--disallowedTools') + 1], '*');
    assert.ok(data.args.includes('--safe-mode'));
    assert.ok(data.input.includes('@private.txt'));
    await assert.rejects(access(data.cwd));
    await assert.rejects(localCliChat({ kind }, [{ role: 'user', content: 'BAD_JSON' }], null, { resolver }), /可用的回答/);
    await assert.rejects(localCliChat({ kind }, [{ role: 'user', content: 'FAIL_PROCESS' }], null, { resolver }), /退出/);
  });
}

test('Claude receives the global fallback as its system prompt without promoting user text', async () => {
  const response = await localCliChat({ kind: 'claude' }, [{ role: 'user', content: 'USER_ONLY_QUESTION' }], null, { resolver });
  const data = JSON.parse(response.text), system = data.args[data.args.indexOf('--system-prompt') + 1];
  assert.ok(system.includes(NEKOMATE_SYSTEM_PROMPT));
  assert.equal(system.includes('USER_ONLY_QUESTION'), false);
  assert.equal(data.input.includes(NEKOMATE_SYSTEM_PROMPT), false);
  assert.ok(data.input.includes('USER_ONLY_QUESTION'));
});

test('CLI config migrates legacy Codex and roundtrips every kind without exposing API keys', () => {
  const legacy = normalizeConfig({ mode: 'codex', codex: { path: process.execPath, model: 'old-model' } });
  assert.equal(legacy.mode, 'cli'); assert.equal(legacy.cli.kind, 'codex');
  assert.equal(legacy.cli.path, process.execPath);
  assert.deepEqual(Object.keys(CLI_TYPES), ['codex', 'claude']);
  for (const kind of Object.keys(CLI_TYPES)) {
    const config = normalizeConfig({ mode: 'cli', cli: { kind, path: process.execPath, model: 'chosen' }, vision: { provider: 'custom', apiKey: 'secret' } });
    assert.equal(config.mode, 'cli');
    assert.deepEqual(normalizeConfig(config).cli, config.cli);
    assert.equal(publicConfig(config).vision.provider, 'custom');
    assert.equal(JSON.stringify(publicConfig(config)).includes('secret'), false);
  }
  assert.throws(() => normalizeConfig({ cli: { kind: 'arbitrary-shell' } }), /CLI/);
  assert.throws(() => normalizeConfig({ cli: { path: 'claude --anything' } }), /完整/);
});

test('unsupported CLI adapters fail before resolving or launching a child', async () => {
  let resolved = false;
  await assert.rejects(localCliChat({ kind: 'arbitrary-shell' }, [], null, {
    resolver: async () => { resolved = true; throw new Error('must not resolve'); },
  }), /不支持的 CLI/);
  assert.equal(resolved, false);
});

test('Windows npm wrapper resolves the known package entry without executing batch code', { skip: process.platform !== 'win32' }, async () => {
  const root = path.resolve(tmpdir()), folder = await mkdtemp(path.join(root, 'deskmate-npm-test-'));
  try {
    const packageDir = path.join(folder, 'node_modules', '@anthropic-ai', 'claude-code');
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(folder, 'claude.cmd'), 'DO NOT EXECUTE THIS');
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
    await writeFile(path.join(packageDir, 'cli.js'), '');
    const launch = await resolveLocalCli({ kind: 'claude', path: path.join(folder, 'claude.cmd') }, { PATH: path.dirname(process.execPath) });
    assert.equal(launch.executable.toLowerCase(), process.execPath.toLowerCase());
    assert.deepEqual(launch.prefix, [path.join(packageDir, 'cli.js')]);
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: '../../outside.js' } }));
    await assert.rejects(resolveLocalCli({ kind: 'claude', path: path.join(folder, 'claude.cmd') }), /入口无效/);
  } finally {
    if (path.dirname(folder) === root && path.basename(folder).startsWith('deskmate-npm-test-')) await rm(folder, { recursive: true, force: true });
  }
});
