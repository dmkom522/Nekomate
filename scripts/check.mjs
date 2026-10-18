import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await visit(path);
    else if (/\.[cm]?js$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit', windowsHide: true });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
await visit('src'); await visit('tests');
console.log('JavaScript syntax checks passed.');
