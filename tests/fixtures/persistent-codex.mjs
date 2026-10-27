// Synthetic App Server protocol fixture. No vendor CLI, model, account, or network.
// One process owns cwd/persistent-codex-state.json; restarting resumes that store.
import readline from 'node:readline';
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const stateFile = path.join(process.cwd(), 'persistent-codex-state.json');
const wireFile = path.join(process.cwd(), 'wire.jsonl');
let state;
try { state = JSON.parse(readFileSync(stateFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, nextThread: 1, nextTurn: 1, threads: {} }; }
const save = () => { writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2)); renameSync(stateFile + '.tmp', stateFile); };
for (const thread of Object.values(state.threads)) {
  for (const turn of thread.turns) if (turn.status === 'inProgress') turn.status = 'interrupted';
}
save();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => { if (id !== undefined) send({ id, result }); };
const fail = (id, message, code = -32602) => send({ id: id ?? null, error: { code, message } });
const timers = new Map();
const getThread = (id, requestId) => {
  const thread = state.threads[id];
  if (!thread) { fail(requestId, 'Thread not found'); return null; }
  return thread;
};
const describe = thread => ({ ...thread, status: { type: thread.turns.some(turn => turn.status === 'inProgress') ? 'active' : 'idle' } });
const textOf = input => (Array.isArray(input) ? input : []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n');
const completion = (thread, turn, text, status = 'completed') => {
  if (turn.status !== 'inProgress') return;
  clearTimeout(timers.get(turn.id)); timers.delete(turn.id);
  turn.status = status;
  if (status === 'completed') {
    const item = { id: `${turn.id}-answer`, type: 'agentMessage', text };
    turn.items.push(item); save();
    const first = Math.max(1, Math.floor(text.length / 2));
    for (const delta of [text.slice(0, first), text.slice(first)]) if (delta) send({ method: 'item/agentMessage/delta', params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta } });
    send({ method: 'item/completed', params: { threadId: thread.id, turnId: turn.id, item } });
  } else save();
  send({ method: 'turn/completed', params: { threadId: thread.id, turn } });
};
process.stdout.on('error', () => process.exit(0));

for await (const line of readline.createInterface({ input: process.stdin })) {
  appendFileSync(wireFile, line + '\n');
  let request; try { request = JSON.parse(line); } catch { fail(null, 'Invalid JSON', -32700); continue; }
  const { id, method, params = {} } = request;
  if (method === 'initialize') reply(id, { userAgent: 'persistent-codex-fixture', platformFamily: 'fixture', platformOs: 'fixture' });
  else if (method === 'initialized') continue;
  else if (method === 'config/read') reply(id, { config: { model_provider: process.env.PERSISTENT_CODEX_FIXTURE_PROVIDER ?? 'fixture' } });
  else if (method === 'account/read') reply(id, { account: { type: 'fixture', email: 'test@example.invalid' } });
  else if (method === 'model/list') reply(id, { data: [{ id: 'fixture-model', model: 'fixture-model', inputModalities: ['text', 'image'], serviceTiers: [{ id: 'priority', name: 'Fast' }] }], nextCursor: null });
  else if (method === 'thread/start') {
    if (process.env.PERSISTENT_CODEX_FIXTURE_FAIL_START === '1') { fail(id, 'Synthetic thread creation failure'); continue; }
    const thread = { id: `fixture-thread-${state.nextThread++}-${randomUUID()}`, ephemeral: params.ephemeral === true, cwd: params.cwd ?? process.cwd(), model: params.model ?? 'fixture-model', serviceTier: params.serviceTier ?? 'default', baseInstructions: params.baseInstructions ?? '', developerInstructions: params.developerInstructions ?? '', turns: [], markers: [] };
    state.threads[thread.id] = thread; save();
    reply(id, { thread: describe(thread), model: thread.model, modelProvider: 'fixture', serviceTier: thread.serviceTier });
    send({ method: 'thread/started', params: { thread: describe(thread) } });
  } else if (method === 'thread/resume' || method === 'thread/read') {
    const thread = getThread(params.threadId, id); if (!thread) continue;
    reply(id, { thread: describe(thread), model: thread.model, modelProvider: 'fixture', serviceTier: thread.serviceTier });
  } else if (method === 'thread/turns/list') {
    const thread = getThread(params.threadId, id); if (!thread) continue;
    reply(id, { data: thread.turns, nextCursor: null });
  } else if (method === 'turn/start') {
    const thread = getThread(params.threadId, id); if (!thread) continue;
    if (thread.turns.some(turn => turn.status === 'inProgress')) { fail(id, 'Thread already has an active turn'); continue; }
    const turnId = `fixture-turn-${state.nextTurn++}`;
    const text = textOf(params.input), clientId = params.clientUserMessageId ?? params.clientId ?? null;
    const turn = { id: turnId, status: 'inProgress', clientUserMessageId: clientId, clientId, items: [{ id: `${turnId}-user`, type: 'userMessage', content: params.input ?? [], clientId, clientUserMessageId: clientId }], error: null };
    thread.turns.push(turn);
    for (const match of text.matchAll(/\bREMEMBER\s*[:= ]\s*([A-Za-z0-9_.-]+)/gi)) if (!thread.markers.includes(match[1])) thread.markers.push(match[1]);
    save(); // Acceptance is durable before the response, including crash simulation.
    if (/\bCRASH_AFTER_ACCEPT\b/.test(text)) process.exit(17);
    reply(id, { turn }); send({ method: 'turn/started', params: { threadId: thread.id, turn } });
    const answer = /\bINSPECT\b/.test(text) ? JSON.stringify({ threadId: thread.id, turnId, input: params.input, remembered: thread.markers, turnCount: thread.turns.length })
      : /\bRECALL\b/i.test(text) ? thread.markers.join(',') || 'NO_MEMORY' : 'fixture answer';
    const requested = /\bDELAY_MS\s*[:=]\s*(\d+)/i.exec(text);
    const delay = requested ? Math.min(30000, Number(requested[1])) : /\b(?:DELAY|WAIT_FOR_CANCEL|HOLD_UNTIL_INTERRUPTED)\b/.test(text) ? 30000 : 5;
    const timer = setTimeout(() => completion(thread, turn, answer), delay); timer.unref(); timers.set(turnId, timer);
  } else if (method === 'turn/interrupt') {
    const thread = getThread(params.threadId, id); if (!thread) continue;
    const turn = thread.turns.find(value => value.id === params.turnId) ?? thread.turns.find(value => value.status === 'inProgress');
    if (!turn) { fail(id, 'Turn not found'); continue; }
    reply(id, {}); completion(thread, turn, '', 'interrupted');
  } else if (method === 'thread/unsubscribe' || method === 'thread/unload') reply(id, {});
  else fail(id, 'Unsupported fixture method', -32601);
}
for (const timer of timers.values()) clearTimeout(timer);
