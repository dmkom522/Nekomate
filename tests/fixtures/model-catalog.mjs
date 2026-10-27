import readline from 'node:readline';
const [kind, mode] = process.argv.slice(2);
let initialized = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const rows = [{ id: 'vision-one', model: 'vision-one', displayName: '视觉一', inputModalities: ['image', 'text'] }, { id: 'text-only', inputModalities: ['text'] }, { id: 'hidden', hidden: true }];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (mode === 'hang') continue;
  if (mode === 'error') { send({ id: request.id, error: { message: 'secret must not leak' } }); continue; }
  if (kind === 'claude') {
    if (request.type !== 'control_request' || request.request.subtype !== 'initialize') process.exit(9);
    send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: [{ value: 'sonnet-fixture', displayName: 'Claude 夹具', inputModalities: ['image'] }] } } });
  } else if (request.method === 'initialize') { initialized = true; send({ id: request.id, result: { protocolVersion: 1 } }); }
  else if (request.method === 'initialized') { if (!initialized) process.exit(9); }
  else if (request.method === 'model/list' && kind === 'codex' && initialized) {
    send({ id: request.id, result: request.params.cursor ? { data: [{ id: 'vision-two', displayName: '视觉二', inputModalities: ['image'] }], nextCursor: null } : { data: rows, nextCursor: 'next' } });
  } else process.exit(9); // Any prompt, chat turn, or model-changing request fails this fixture.
}
