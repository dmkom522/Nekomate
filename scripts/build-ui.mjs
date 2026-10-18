import { build } from 'esbuild';
import { mkdir, cp, copyFile } from 'node:fs/promises';
await mkdir('src/renderer/vendor', { recursive: true });
await build({ entryPoints: ['src/renderer/format.mjs'], outfile: 'src/renderer/vendor/format.mjs', bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'chrome130' });
await copyFile('node_modules/katex/dist/katex.min.css', 'src/renderer/vendor/katex.min.css');
await cp('node_modules/katex/dist/fonts', 'src/renderer/vendor/fonts', { recursive: true });
console.log('Local Markdown and math renderer built.');
