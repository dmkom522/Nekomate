import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { LearningSessions } from '../src/core/learning-session.mjs';
import { CodexSession } from '../src/core/codex-session.mjs';
import { NEKOMATE_SYSTEM_PROMPT } from '../src/core/prompts.mjs';
import { validateNotes } from '../src/core/visual-memory.mjs';

const fixture = path.resolve('tests/fixtures/persistent-codex.mjs');
const config = { mode: 'cli', cli: { kind: 'codex', path: process.execPath, model: 'fixture-model' } };
const apiConfig = { mode: 'api', vision: { provider: 'custom', protocol: 'openai', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-secret', model: 'fixture-model' } };
const image = 'data:image/png;base64,aGVsbG8=';
const frame = (eventId, time = 1) => ({ eventId, time, image });
const transcript = (eventId, text, start = 0, end = 2) => ({ eventId, text, start, end });
const textOf = parts => parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
const launch = provider => ({ executable: process.execPath, prefix: [fixture], env: { ...process.env, PERSISTENT_CODEX_FIXTURE_PROVIDER: provider ?? 'fixture' } });

test('an overlong background response remains a valid savable note when recovered from the event cache', async t => {
  const { manager } = await setup(t, { apiComplete: async () => ({ text: '课程内容'.repeat(1500), model: 'fixture-model' }) });
  await manager.create('long-note', apiConfig);
  const input = { eventId: 'long-note-event', frame: frame('long-note-image'), source: 'lecture' };
  const result = await manager.run('long-note', 'visual-note', input, apiConfig);
  assert.doesNotThrow(() => validateNotes([{ text: result.text, time: 1, source: 'lecture' }]));
  assert.match(result.text, /后文已截断/);
  assert.equal((await manager.run('long-note', 'visual-note', input, apiConfig)).text, result.text);
});

async function stop(manager) {
  const children = [...manager.adapters.values()].map(adapter => adapter.child).filter(child => child && child.exitCode === null && child.signalCode === null);
  const exits = children.map(child => once(child, 'close'));
  manager.dispose();
  await Promise.all(exits);
}
async function setup(t, options = {}) {
  const temporaryRoot = path.resolve('.local');
  await mkdir(temporaryRoot, { recursive: true });
  const root = await mkdtemp(path.join(temporaryRoot, 'nekomate-learning-session-'));
  const managers = [];
  const create = extra => {
    const manager = new LearningSessions({ root, resolver: async () => launch(), fastMode: async () => null, ...options, ...extra });
    managers.push(manager); return manager;
  };
  t.after(async () => {
    await Promise.all(managers.map(stop));
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith('nekomate-learning-session-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { root, create, manager: create() };
}
async function binding(root, id) { return JSON.parse(await readFile(path.join(root, id, 'binding.json'), 'utf8')); }
async function wire(root, id) {
  return (await readFile(path.join(root, id, 'work', 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
async function fixtureState(root, id) {
  return JSON.parse(await readFile(path.join(root, id, 'work', 'persistent-codex-state.json'), 'utf8'));
}
test('native learning keeps one durable thread across all tasks and an explicit new learning is isolated', async t => {
  const { root, create, manager } = await setup(t);
  await manager.create('course-a', config);
  await manager.run('course-a', 'visual-note', { eventId: 'note-a', frame: frame('frame-a'), source: 'REMEMBER:COURSE_A' }, config);
  await manager.run('course-a', 'course-context', { eventId: 'background-a', frames: [frame('frame-a')], source: 'lecture' }, config);
  const answer = await manager.run('course-a', 'answer', { eventId: 'question-a', question: 'RECALL', frames: [frame('question-frame-a')], transcripts: [transcript('audio-a', 'REMEMBER:AUDIO_A')] }, config);
  assert.equal(answer.answer, 'COURSE_A,AUDIO_A');
  assert.deepEqual(answer.acceptedTranscriptIds, ['audio-a']);
  const original = await binding(root, 'course-a');
  let requests = await wire(root, 'course-a');
  assert.equal(requests.filter(request => request.method === 'thread/start').length, 1);
  const turns = requests.filter(request => request.method === 'turn/start');
  assert.equal(turns.length, 3);
  assert.ok(turns.every(request => request.params.threadId === original.nativeId));
  assert.equal(turns[0].params.input.filter(part => part.type === 'image').length, 1);
  assert.equal(turns[1].params.input.filter(part => part.type === 'image').length, 0, 'already accepted background sample is referenced within the thread');
  assert.equal(textOf(turns[2].params.input).includes('REMEMBER:COURSE_A'), false, 'old notes are not replayed in a question');
  assert.equal(requests.some(request => request.method === 'thread/resume' && request.params.config.web_search === 'live'), true);

  await manager.create('course-b', config);
  const other = await manager.run('course-b', 'answer', { eventId: 'question-b', question: 'RECALL' }, config);
  assert.notEqual((await binding(root, 'course-b')).nativeId, original.nativeId);
  assert.equal(other.answer, 'NO_MEMORY');

  await stop(manager);
  const restarted = create();
  await restarted.resume('course-a', config);
  const resumed = await restarted.run('course-a', 'answer', { eventId: 'question-after-restart', question: 'RECALL' }, config);
  assert.equal(resumed.answer, 'COURSE_A,AUDIO_A');
  assert.equal((await binding(root, 'course-a')).nativeId, original.nativeId);
  requests = await wire(root, 'course-a');
  assert.equal(requests.filter(request => request.method === 'thread/start').length, 1, 'restart resumes instead of creating another thread');
  assert.equal(textOf(requests.filter(request => request.method === 'turn/start').at(-1).params.input).includes('REMEMBER:'), false);
});

test('missing local binding or native history fails without quietly creating a replacement thread', async t => {
  let resolved = 0;
  const { root, create, manager } = await setup(t, { resolver: async () => { resolved++; return launch(); } });
  await assert.rejects(manager.resume('never-created', config), /没有可恢复/);
  await assert.rejects(manager.run('never-created', 'answer', { eventId: 'missing-question', question: 'RECALL' }, config), /没有可恢复/);
  assert.equal(resolved, 0, 'no CLI launched without an existing explicit learning');
  await manager.create('existing', config);
  await manager.run('existing', 'answer', { eventId: 'create-durable-history', question: 'REMEMBER:SAVED' }, config);
  await stop(manager);
  const stateFile = path.join(root, 'existing', 'work', 'persistent-codex-state.json');
  const state = await fixtureState(root, 'existing');
  state.threads = {};
  await writeFile(stateFile, JSON.stringify(state));
  const restored = create();
  await assert.rejects(restored.resume('existing', config), /原会话|会话.*失败/);
  const requests = await wire(root, 'existing');
  assert.equal(requests.filter(request => request.method === 'thread/start').length, 1);
  assert.equal(requests.at(-1).method, 'thread/resume');
});

test('cancelled accepted input is continued without reuploading its image or transcript, and transcript IDs deduplicate later events', async t => {
  let acknowledged;
  const receipt = new Promise(resolve => { acknowledged = resolve; });
  const { root, manager } = await setup(t, { codexFactory: options => new CodexSession({
    ...options,
    onState: async update => {
      // Wait for the real manager's durable receipt, rather than repeatedly opening
      // the replace destination while Windows is committing its atomic rename.
      await options.onState(update);
      if (update.acceptedEventId === 'question-pending') acknowledged();
    },
  }) });
  await manager.create('lecture', config);
  const question = { eventId: 'question-pending', question: 'DELAY REMEMBER:QUESTION_A', frames: [frame('question-picture')], transcripts: [transcript('audio-1', 'FIRST_TRANSCRIPT REMEMBER:AUDIO_ONE')] };
  const controller = new AbortController();
  const pending = manager.run('lecture', 'answer', question, config, controller.signal);
  pending.catch(() => {});
  let deadline;
  try {
    await Promise.race([
      receipt,
      pending.then(() => assert.fail('Delayed question completed before its native acceptance could be observed')),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Native acceptance acknowledgement did not arrive within 4 seconds')), 4000); }),
    ]);
  } finally { clearTimeout(deadline); }
  const durable = (await binding(root, 'lecture')).events.find(event => event.id === question.eventId);
  assert.equal(durable.accepted, true, 'native receipt is present in the actual saved binding before cancellation');
  assert.equal(durable.uncertain, false);
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.deepEqual((await manager.status('lecture', config)).acceptedTranscriptIds, ['audio-1']);
  const continued = await manager.run('lecture', 'answer', question, config);
  assert.equal(continued.answer, 'fixture answer');
  let turns = (await wire(root, 'lecture')).filter(request => request.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].params.input.some(part => part.type === 'image'), false);
  assert.equal(textOf(turns[1].params.input).includes('FIRST_TRANSCRIPT'), false);
  assert.ok(textOf(turns[1].params.input).includes('继续完成先前已收到的'));
  const next = await manager.run('lecture', 'answer', { eventId: 'question-next', question: 'RECALL', transcripts: [question.transcripts[0], transcript('audio-2', 'SECOND_TRANSCRIPT REMEMBER:AUDIO_TWO', 2, 4)] }, config);
  assert.equal(next.answer, 'QUESTION_A,AUDIO_ONE,AUDIO_TWO');
  assert.deepEqual(next.acceptedTranscriptIds, ['audio-1', 'audio-2']);
  turns = (await wire(root, 'lecture')).filter(request => request.method === 'turn/start');
  assert.equal(textOf(turns[2].params.input).includes('FIRST_TRANSCRIPT'), false);
  assert.ok(textOf(turns[2].params.input).includes('SECOND_TRANSCRIPT'));
  const allInputs = turns.map(turn => textOf(turn.params.input)).join('\n');
  assert.equal(allInputs.split('FIRST_TRANSCRIPT').length - 1, 1);
  const count = turns.length;
  const cached = await manager.run('lecture', 'answer', question, config);
  assert.equal(cached.answer, continued.answer);
  assert.equal((await wire(root, 'lecture')).filter(request => request.method === 'turn/start').length, count);
});

test('API keeps an exact canonical conversation across tasks and restart, caches events, and excludes legacy replay fields', async t => {
  const calls = [];
  const apiComplete = async (_config, messages, _signal, _unused, onDelta, options) => {
    calls.push({ messages: structuredClone(messages), options });
    const text = `canonical-response-${calls.length}`;
    onDelta?.(text); return { text, model: 'fixture-model', usage: { total_tokens: calls.length } };
  };
  const { root, create, manager } = await setup(t, { apiComplete });
  await manager.create('api-lecture', apiConfig);
  const note = { eventId: 'api-note', frame: frame('api-picture'), source: 'lecture', history: [{ role: 'assistant', content: 'LEGACY_HISTORY' }], analyses: [{ text: 'LEGACY_NOTES' }], courseContext: { text: 'LEGACY_BACKGROUND' } };
  await manager.run('api-lecture', 'visual-note', note, apiConfig);
  const storedAfterNote = (await binding(root, 'api-lecture')).messages;
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(calls[0].messages[0].content, NEKOMATE_SYSTEM_PROMPT);
  const question = { eventId: 'api-question', question: 'FIRST_QUESTION', transcripts: [transcript('api-audio', 'NEW_TRANSCRIPT')], history: [{ role: 'assistant', content: 'LEGACY_HISTORY' }], analyses: [{ text: 'LEGACY_NOTES' }], courseContext: { text: 'LEGACY_BACKGROUND' } };
  const answer = await manager.run('api-lecture', 'answer', question, apiConfig);
  assert.deepEqual(calls[1].messages.slice(0, -1), storedAfterNote);
  assert.deepEqual(calls[1].messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(JSON.stringify(calls).includes('LEGACY_'), false);
  assert.equal(calls[0].options.allowWeb, false);
  const cached = await manager.run('api-lecture', 'answer', question, apiConfig);
  assert.equal(cached.answer, answer.answer);
  assert.equal(calls.length, 2);
  await assert.rejects(manager.run('api-lecture', 'answer', { ...question, question: 'DIFFERENT_CONTENT' }, apiConfig), /事件编号/);
  assert.equal(calls.length, 2);

  await stop(manager);
  const restored = create();
  await restored.resume('api-lecture', apiConfig);
  const storedBeforeRestartQuestion = (await binding(root, 'api-lecture')).messages;
  await restored.run('api-lecture', 'answer', { eventId: 'api-after-restart', question: 'FOLLOWUP', transcripts: question.transcripts }, apiConfig);
  assert.deepEqual(calls[2].messages.slice(0, -1), storedBeforeRestartQuestion);
  assert.equal(textOf(calls[2].messages.at(-1).content).includes('NEW_TRANSCRIPT'), false);
  assert.equal(JSON.stringify(calls[2].messages).split('NEW_TRANSCRIPT').length - 1, 1);
  assert.deepEqual((await binding(root, 'api-lecture')).messages.map(message => message.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
});

test('status reconciles durable native acceptance after a transport crash before its acknowledgement', async t => {
  const { root, manager } = await setup(t);
  await manager.create('transport-loss', config);
  const question = { eventId: 'lost-response', question: 'CRASH_AFTER_ACCEPT REMEMBER:BEFORE_CRASH', frames: [frame('lost-picture')], transcripts: [transcript('audio-before-crash', 'DURABLE_TRANSCRIPT')] };
  await assert.rejects(manager.run('transport-loss', 'answer', question, config), /连接.*断开/);
  const uncertain = (await binding(root, 'transport-loss')).events.find(event => event.id === question.eventId);
  assert.equal(uncertain.uncertain, true);
  assert.equal(uncertain.accepted, false);
  const status = await manager.status('transport-loss', config);
  assert.deepEqual(status.acceptedTranscriptIds, ['audio-before-crash']);
  const reconciled = (await binding(root, 'transport-loss')).events.find(event => event.id === question.eventId);
  assert.equal(reconciled.accepted, true);
  assert.equal(reconciled.uncertain, false);
  const continued = await manager.run('transport-loss', 'answer', question, config);
  assert.equal(continued.answer, 'fixture answer');
  const requests = await wire(root, 'transport-loss');
  assert.equal(requests.filter(request => request.method === 'thread/start').length, 1);
  const inputs = requests.filter(request => request.method === 'turn/start').map(request => request.params.input);
  assert.equal(inputs.length, 2);
  assert.equal(inputs.flat().filter(part => part.type === 'image').length, 1);
  assert.equal(textOf(inputs.flat()).split('DURABLE_TRANSCRIPT').length - 1, 1);
});

test('changing a saved connection or native provider refuses resume while preserving the original learning', async t => {
  const { root, create, manager } = await setup(t);
  await manager.create('original', config);
  await manager.run('original', 'answer', { eventId: 'original-first-turn', question: 'REMEMBER:ORIGINAL' }, config);
  const original = await binding(root, 'original');
  await assert.rejects(manager.resume('original', { ...config, cli: { ...config.cli, path: '/different/executable' } }), /连接不同/);
  await stop(manager);
  const changed = create({ resolver: async () => launch('different-fixture-provider') });
  await assert.rejects(changed.resume('original', config), /账户或服务已改变/);
  assert.equal((await binding(root, 'original')).nativeId, original.nativeId);
  assert.equal((await wire(root, 'original')).filter(request => request.method === 'thread/start').length, 1);
});

test('an explicit empty learning survives restart as a reservation and creates one web-enabled thread with its first course input', async t => {
  const { root, create, manager } = await setup(t);
  await manager.create('empty-learning', config);
  const allocated = await binding(root, 'empty-learning');
  assert.equal(allocated.state, 'allocated');
  assert.equal(allocated.nativeId, undefined);
  assert.equal((await wire(root, 'empty-learning')).filter(request => request.method === 'thread/start').length, 0);
  await stop(manager);
  const restarted = create();
  await restarted.resume('empty-learning', config);
  assert.equal((await binding(root, 'empty-learning')).state, 'allocated');
  let requests = await wire(root, 'empty-learning');
  assert.equal(requests.some(request => ['thread/start', 'thread/resume'].includes(request.method)), false);
  const course = { eventId: 'first-course-input', source: 'REMEMBER:RESERVED_COURSE', frames: [frame('reserved-course-picture')] };
  await restarted.run('empty-learning', 'course-context', course, config);
  const ready = await binding(root, 'empty-learning');
  assert.equal(ready.state, 'ready');
  assert.ok(ready.nativeId);
  requests = await wire(root, 'empty-learning');
  const starts = requests.filter(request => request.method === 'thread/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.config.web_search, 'live');
  const startIndex = requests.findIndex(request => request.method === 'thread/start');
  const firstTurnIndex = requests.findIndex(request => request.method === 'turn/start');
  assert.ok(firstTurnIndex > startIndex);
  assert.equal(requests.slice(startIndex + 1, firstTurnIndex).some(request => request.method === 'thread/resume'), false, 'Codex cannot resume a new empty thread before its first turn persists');
  const followup = await restarted.run('empty-learning', 'answer', { eventId: 'reserved-followup', question: 'RECALL' }, config);
  assert.equal(followup.answer, 'RESERVED_COURSE');
  assert.equal((await binding(root, 'empty-learning')).nativeId, ready.nativeId);
  assert.equal((await wire(root, 'empty-learning')).filter(request => request.method === 'thread/start').length, 1);
});

test('a failed native thread creation is never retried as an automatic replacement, including after restart', async t => {
  const { root, create, manager } = await setup(t, { resolver: async () => ({ ...launch(), env: { ...launch().env, PERSISTENT_CODEX_FIXTURE_FAIL_START: '1' } }) });
  await manager.create('failed-creation', config);
  const input = { eventId: 'first-failed-event', question: 'create a native thread once' };
  await assert.rejects(manager.run('failed-creation', 'answer', input, config), /会话|thread\/start/);
  const failed = await binding(root, 'failed-creation');
  assert.notEqual(failed.state, 'allocated');
  assert.equal(failed.nativeId, undefined);
  await stop(manager);
  const restarted = create({ resolver: async () => launch() });
  await assert.rejects(restarted.resume('failed-creation', config), /会话|创建|新的学习/);
  await assert.rejects(restarted.run('failed-creation', 'answer', input, config), /会话|创建|新的学习/);
  assert.equal((await wire(root, 'failed-creation')).filter(request => request.method === 'thread/start').length, 1);
});
