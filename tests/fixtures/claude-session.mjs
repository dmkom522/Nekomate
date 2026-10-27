// A deterministic native CLI protocol fixture. It does not contact Anthropic.
import path from 'node:path';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const mode = process.env.CLAUDE_FIXTURE_MODE ?? 'success';
const send = event => process.stdout.write(JSON.stringify(event) + '\n');
const id = args[args.indexOf('--resume') + 1] ?? '';
const sessionId = args.includes('--resume') ? id : args[args.indexOf('--session-id') + 1];
const project = process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', project);
const file = path.join(folder, `${sessionId}.jsonl`);
let source = '';
for await (const chunk of process.stdin) source += chunk;
const input = JSON.parse(source);
if (mode === 'fail-before-ack') process.exit(7);
let before = [];
try { before = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (args.includes('--resume') && !before.length) process.exit(8);
if (args.includes('--session-id') && before.length) process.exit(9);
if (args.includes('--no-session-persistence') || args.includes('--fork-session')) process.exit(10);
await mkdir(folder, { recursive: true });
const user = { ...input, sessionId, parentUuid: before.at(-1)?.uuid ?? null };
await appendFile(file, JSON.stringify(user) + '\n');
send({ type: 'system', subtype: 'init', session_id: sessionId });
send({ ...input, session_id: sessionId });
if (mode === 'fail-after-receipt') process.exit(11);
if (mode === 'cancel-after-receipt') await new Promise(resolve => setTimeout(resolve, 30_000));
if (mode === 'wrong-session') { send({ type: 'system', session_id: randomUUID() }); process.exit(0); }
const text = JSON.stringify({ args, cwd: process.cwd(), input: input.message.content, priorUserMessages: before.filter(row => row.type === 'user').length });
const assistant = { type: 'assistant', sessionId, uuid: randomUUID(), parentUuid: input.uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } };
await appendFile(file, JSON.stringify(assistant) + '\n');
send({ type: 'stream_event', session_id: sessionId, event: { delta: { type: 'text_delta', text } } });
send({ ...assistant, session_id: sessionId });
if (mode === 'lose-result') process.exit(12);
send({ type: 'result', subtype: 'success', session_id: sessionId, result: text, usage: { input_tokens: 1, output_tokens: 1 } });
