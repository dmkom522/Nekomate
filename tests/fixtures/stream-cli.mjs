import readline from 'node:readline';
const [kind, ...args] = process.argv.slice(2);
if (!['codex', 'claude'].includes(kind)) process.exit(9);
const mode = args.find(arg => arg.startsWith('--fixture-mode='))?.split('=')[1];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const delay = () => new Promise(resolve => setTimeout(resolve, 80));
async function chunks() {
  for (const text of ['第一段', '第二段']) {
    if (kind === 'codex') send({ method: 'item/agentMessage/delta', params: { threadId: 'fixture', delta: text } });
    if (kind === 'claude') send({ type: 'stream_event', event: { delta: { type: 'text_delta', text } } });
    await delay();
  }
}
if (kind === 'codex') {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') { if (mode !== 'handshake-hang') send({ id: message.id, result: {} }); }
    else if (message.method === 'initialized') continue;
    else if (message.method === 'thread/start') {
      if (!message.params.ephemeral || message.params.approvalPolicy !== 'never') process.exit(9);
      send({ id: message.id, result: { thread: { id: 'fixture' } } });
    } else if (message.method === 'turn/start') {
      if (mode === 'local-tool-request') { send({ id: 812, method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture', command: 'must never run' } }); continue; }
      if (mode === 'web-search') {
        const item = { type: 'webSearch', id: 'web-fixture', query: '公开课程主题', action: { type: 'openPage', url: 'https://example.com/course' } };
        send({ method: 'item/started', params: { threadId: 'fixture', item } });
        send({ method: 'item/completed', params: { threadId: 'fixture', item } });
      }
      if (mode === 'failed-turn') { send({ method: 'error', params: { threadId: 'fixture', willRetry: false, error: { codexErrorInfo: 'usageLimitExceeded', message: 'secret must not leak' } } }); continue; }
      if (mode === 'inspect' || mode === 'final-only') {
        const text = mode === 'inspect' ? JSON.stringify({ args, input: message.params.input, cwd: process.cwd() }) : '只有完成事件的回答';
        send({ method: 'item/completed', params: { threadId: 'fixture', item: { type: 'agentMessage', id: 'answer', text } } });
      } else await chunks();
      send({ method: 'turn/completed', params: { threadId: 'fixture', turn: { status: 'completed' } } });
    } else process.exit(9);
  }
} else {
  for await (const chunk of process.stdin) { /* drain */ }
  if (args[args.indexOf('--output-format') + 1] !== 'stream-json') process.exit(9);
  await chunks(); send({ type: 'result', result: '第一段第二段', status: 'success' });
}
