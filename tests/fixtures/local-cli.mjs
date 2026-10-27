// Protocol fixture, not an actual vendor CLI. Echo decoded input for transport tests.
const [kind, ...args] = process.argv.slice(2);
if (kind !== 'claude') process.exit(9);
let input = ''; for await (const chunk of process.stdin) input += chunk;
if (input.includes('FAIL_PROCESS')) process.exit(2);
if (input.includes('BAD_JSON')) { process.stdout.write('invalid'); process.exit(0); }
const result = { cwd: process.cwd(), args, input, images: [] };
const data = JSON.parse(input);
for (const part of data.message.content) {
  if (part.type === 'image') result.images.push(Buffer.from(part.source.data, 'base64').toString('base64'));
}
const answer = JSON.stringify(result);
process.stdout.write(JSON.stringify({ result: answer }) + '\n');
