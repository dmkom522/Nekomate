// Real child-process fixture: receives stdin and image paths, never contacts a model.
import { readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2), chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString();
if (prompt.includes('WAIT_FOR_CANCEL')) { setInterval(() => {}, 1000); }
else if (prompt.includes('FAIL_PROCESS')) { process.exitCode = 2; }
else {
  const output = args[args.indexOf('--output-last-message') + 1];
  const index = args.indexOf('--image');
  const image = index === -1 ? null : (await readFile(args[index + 1])).toString('base64');
  await writeFile(output, JSON.stringify({ prompt, image, args, cwd: process.cwd() }));
}
