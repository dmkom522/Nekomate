import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ClaudeSession, claudeSessionTranscriptPath } from '../src/core/claude-session.mjs';

const fixture = path.resolve('tests/fixtures/claude-session.mjs');
async function setup(t, mode = 'success') {
  const tempRoot = path.resolve(tmpdir()), root = await mkdtemp(path.join(tempRoot, 'nekomate-claude-session-'));
  t.after(async () => { if (path.dirname(root) === tempRoot && path.basename(root).startsWith('nekomate-claude-session-')) await rm(root, { recursive: true, force: true }); });
  const cwd = path.join(root, 'course'); await mkdir(cwd);
  const launch = { executable: process.execPath, prefix: [fixture], env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'profile'), CLAUDE_FIXTURE_MODE: mode } };
  const sessionId = randomUUID(), states = [];
  const options = { launch, cwd, sessionId, create: true, initialInstructions: 'Nekomate global instructions', onState: state => states.push(state) };
  const session = new ClaudeSession(options);
  return { root, cwd, launch, sessionId, states, options, session, nativeFile: () => claudeSessionTranscriptPath({ ...options, env: launch.env }) };
}

test('Claude starts one native UUID and resumes it for screenshots, transcripts and questions across restart', async t => {
  const x = await setup(t);
  assert.equal((await x.session.validateResume()).state, 'allocated');
  const image = { type: 'image', url: 'data:image/png;base64,aGVsbG8=' };
  const first = await x.session.run({ eventId: 'screen-1', input: [{ type: 'text', text: '[Nekomate event:screen-1]\nPRIVATE_FIRST_NOTE' }, image], task: '后台读图' });
  const initial = JSON.parse(first.text);
  assert.equal(initial.args.includes('--session-id'), true);
  assert.equal(initial.args.includes('--resume'), false);
  assert.equal(initial.args.includes('--no-session-persistence'), false);
  assert.equal(initial.priorUserMessages, 0);
  assert.deepEqual(initial.input[1].source, { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' });
  assert.equal(initial.input.filter(p => p.type === 'text').map(p => p.text).join('').split('[Nekomate event:screen-1]').length, 2);
  const second = await x.session.run({ eventId: 'audio-1', input: 'PRIVATE_SECOND_TRANSCRIPT', task: '保存新转写' });
  const followup = JSON.parse(second.text);
  assert.equal(followup.args[followup.args.indexOf('--resume') + 1], x.sessionId);
  assert.equal(followup.args.includes('--session-id'), false);
  assert.equal(followup.priorUserMessages, 1);
  assert.equal(JSON.stringify(followup.input).includes('PRIVATE_FIRST_NOTE'), false);
  assert.equal(followup.input.some(p => p.type === 'image'), false);
  const restored = new ClaudeSession({ ...x.options, create: false });
  await restored.validateResume();
  const third = JSON.parse((await restored.run({ eventId: 'question-1', input: '这个矩阵是什么意思？', model: 'test-model', fastMode: { type: 'claude' } })).text);
  assert.equal(third.priorUserMessages, 2);
  assert.equal(third.cwd, x.cwd);
  assert.equal(third.args.includes('--resume'), true);
  assert.equal(third.args[third.args.indexOf('--settings') + 1], '{"disableAllHooks":true,"fastMode":true}');
  assert.equal(x.states.filter(state => state.acceptedEventId).length, 3);
  assert.equal(first.sessionId, third.args[third.args.indexOf('--resume') + 1]);
});

test('missing and mismatched native transcripts never silently start a replacement', async t => {
  const x = await setup(t);
  const restored = new ClaudeSession({ ...x.options, create: false });
  await assert.rejects(restored.validateResume(), { code: 'CLAUDE_SESSION_MISSING' });
  await assert.rejects(restored.run({ eventId: 'question', input: 'test' }), { code: 'CLAUDE_SESSION_MISSING' });
  assert.equal(await x.nativeFile(), null);
  const file = path.join(x.root, 'wrong.jsonl');
  await writeFile(file, JSON.stringify({ type: 'user', sessionId: randomUUID(), message: { content: 'wrong' } }) + '\n');
  await assert.rejects(new ClaudeSession({ ...x.options, create: false, transcriptPath: file }).validateResume(), { code: 'CLAUDE_SESSION_MISMATCH' });
});

test('a completed event can be recovered after losing the final result without resending data', async t => {
  const x = await setup(t, 'lose-result');
  await assert.rejects(x.session.run({ eventId: 'once', input: 'SOURCE_ONCE' }), error => error.accepted === true);
  const before = await readFile(await x.nativeFile(), 'utf8');
  const recovered = await x.session.run({ eventId: 'once', input: 'SOURCE_ONCE' });
  assert.equal(recovered.replayed, true);
  assert.equal(await readFile(await x.nativeFile(), 'utf8'), before);
  assert.ok(x.states.some(state => state.acceptedEventId === 'once'));
});

test('an accepted unfinished event continues in its original native session without resending the image', async t => {
  const x = await setup(t, 'fail-after-receipt');
  await assert.rejects(x.session.run({ eventId: 'partial', input: [{ type: 'text', text: 'ORIGINAL_IMAGE_DESCRIPTION' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YQ==' } }] }), error => error.accepted === true);
  assert.ok(x.states.some(state => state.acceptedEventId === 'partial'));
  x.launch.env.CLAUDE_FIXTURE_MODE = 'success';
  const result = JSON.parse((await x.session.run({ eventId: 'partial', input: 'ORIGINAL_IMAGE_DESCRIPTION' })).text);
  assert.equal(result.args.includes('--resume'), true);
  assert.equal(result.priorUserMessages, 1);
  assert.equal(result.input.some(part => part.type === 'image'), false);
  assert.equal(JSON.stringify(result.input).includes('ORIGINAL_IMAGE_DESCRIPTION'), false);
  assert.ok(JSON.stringify(result.input).includes('继续完成'));
});

test('an unconfirmed initial submission is not retried as another new native conversation', async t => {
  const x = await setup(t, 'fail-before-ack');
  await assert.rejects(x.session.run({ eventId: 'uncertain', input: 'test' }), error => error.uncertain && !error.accepted);
  x.launch.env.CLAUDE_FIXTURE_MODE = 'success';
  await assert.rejects(x.session.run({ eventId: 'uncertain', input: 'test' }), { code: 'CLAUDE_SESSION_MISSING' });
  const snapshot = x.states.at(-1);
  await assert.rejects(new ClaudeSession({ ...x.options, create: true, ...snapshot }).validateResume(), { code: 'CLAUDE_SESSION_MISSING' });
  assert.equal(await x.nativeFile(), null);
});

test('course web search stays in the same native conversation and retains tool restrictions', async t => {
  const x = await setup(t);
  await x.session.run({ eventId: 'screen', input: '课程首图' });
  const data = JSON.parse((await x.session.run({ eventId: 'course-context', input: '根据初期截图搜索课程信息', allowWeb: true, task: '集中查询课程背景' })).text);
  assert.equal(data.args[data.args.indexOf('--resume') + 1], x.sessionId);
  assert.equal(data.args[data.args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(data.args[data.args.indexOf('--disallowedTools') + 1], 'Bash,Read,Write,Edit,Glob,Grep,Agent,Task,mcp__*');
  assert.equal(data.args[data.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(data.args.includes('--safe-mode'), true);
  assert.equal(data.args.includes('--strict-mcp-config'), true);
  assert.ok(data.args[data.args.indexOf('--system-prompt') + 1].includes('Nekomate global instructions'));
});

test('a failed unacknowledged request on an existing session cannot duplicate its input on retry', async t => {
  const x = await setup(t);
  await x.session.run({ eventId: 'first', input: 'native history' });
  x.launch.env.CLAUDE_FIXTURE_MODE = 'fail-before-ack';
  await assert.rejects(x.session.run({ eventId: 'unknown', input: 'uncertain input' }), error => error.uncertain && !error.accepted);
  x.launch.env.CLAUDE_FIXTURE_MODE = 'success';
  await assert.rejects(x.session.run({ eventId: 'unknown', input: 'uncertain input' }), { code: 'CLAUDE_RECEIPT_UNKNOWN' });
  const data = await readFile(await x.nativeFile(), 'utf8');
  assert.equal(data.includes('uncertain input'), false);
  const next = JSON.parse((await x.session.run({ eventId: 'different', input: 'an explicit later question' })).text);
  assert.equal(next.priorUserMessages, 1);
  assert.equal(next.args[next.args.indexOf('--resume') + 1], x.sessionId);
});

test('native project directory overrides and hashed long working directories are located by UUID', async t => {
  const x = await setup(t);
  const id = randomUUID(), cwd = path.join(x.cwd, 'a'.repeat(220));
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const folder = path.join(x.launch.env.CLAUDE_CONFIG_DIR, 'projects', encoded.slice(0, 200) + '-hash');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`); await writeFile(file, '{}\n');
  assert.equal(await claudeSessionTranscriptPath({ cwd, sessionId: id, env: x.launch.env }), file);
  const override = 'stable-project', otherFolder = path.join(x.launch.env.CLAUDE_CONFIG_DIR, 'projects', override);
  await mkdir(otherFolder, { recursive: true });
  const otherFile = path.join(otherFolder, `${id}.jsonl`); await writeFile(otherFile, '{}\n');
  assert.equal(await claudeSessionTranscriptPath({ cwd, sessionId: id, env: { ...x.launch.env, CLAUDE_CODE_PROJECT_DIR_NAME: override } }), otherFile);
  await assert.rejects(claudeSessionTranscriptPath({ cwd, sessionId: id, env: { ...x.launch.env, CLAUDE_CODE_PROJECT_DIR_NAME: '../outside' } }), { code: 'CLAUDE_SESSION_INVALID' });
});

test('connection identity hashes selected endpoint, key and OAuth account fields without exposing secrets', async t => {
  const x = await setup(t);
  const profile = x.launch.env.CLAUDE_CONFIG_DIR;
  await mkdir(profile, { recursive: true });
  const settingsFile = path.join(profile, 'settings.json'), accountFile = path.join(profile, '.claude.json');
  const settings = { env: { ANTHROPIC_BASE_URL: 'https://gateway.example/v1', ANTHROPIC_AUTH_TOKEN: 'PRIVATE_AUTH_A' }, theme: 'light' };
  await writeFile(settingsFile, JSON.stringify(settings));
  await writeFile(accountFile, JSON.stringify({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'org-a', emailAddress: 'unused@example.test' }, projects: { private: 'do not hash' } }));
  const original = await x.session.identity();
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(original.includes('PRIVATE_AUTH'), false);
  settings.theme = 'dark'; await writeFile(settingsFile, JSON.stringify(settings));
  await writeFile(accountFile, JSON.stringify({ oauthAccount: { accountUuid: 'account-a', organizationUuid: 'org-a', emailAddress: 'changed@example.test' }, projects: { other: 'unrelated' } }));
  assert.equal(await x.session.identity(), original);
  settings.env.ANTHROPIC_AUTH_TOKEN = 'PRIVATE_AUTH_B'; await writeFile(settingsFile, JSON.stringify(settings));
  assert.notEqual(await x.session.identity(), original);
  settings.env.ANTHROPIC_AUTH_TOKEN = 'PRIVATE_AUTH_A'; await writeFile(settingsFile, JSON.stringify(settings));
  await writeFile(accountFile, JSON.stringify({ oauthAccount: { accountUuid: 'account-b', organizationUuid: 'org-a' } }));
  assert.notEqual(await x.session.identity(), original);
});

test('concurrent turns are rejected before a second native process receives input', async t => {
  const x = await setup(t, 'cancel-after-receipt');
  const abort = new AbortController();
  const run = x.session.run({ eventId: 'one-at-a-time', input: 'first question', signal: abort.signal });
  await assert.rejects(x.session.run({ eventId: 'second', input: 'must not send' }), { code: 'CLAUDE_SESSION_BUSY' });
  abort.abort();
  await assert.rejects(run);
});

test('cancellation preserves the accepted native input and does not kill another session', async t => {
  const x = await setup(t, 'cancel-after-receipt');
  const abort = new AbortController();
  const run = x.session.run({ eventId: 'cancel', input: 'saved before cancellation', signal: abort.signal });
  for (let n = 0; n < 150 && !await x.nativeFile(); n++) await new Promise(resolve => setTimeout(resolve, 20));
  abort.abort();
  await assert.rejects(run, error => error.accepted === true);
  assert.ok(await x.nativeFile());
  const restored = new ClaudeSession({ ...x.options, create: false, state: 'ready', pendingEventId: 'cancel' });
  await restored.validateResume();
  x.launch.env.CLAUDE_FIXTURE_MODE = 'success';
  const result = await restored.run({ eventId: 'new-question', input: 'a later question' });
  assert.equal(JSON.parse(result.text).priorUserMessages, 1);
});
