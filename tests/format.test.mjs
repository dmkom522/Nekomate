import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAnswer } from '../src/renderer/format.mjs';

test('renders matrices, inline math and code without interpreting raw HTML', () => {
  const text = '# 消元\n\n公式 $Ax=b$。\n\n$$\n\\begin{bmatrix}1&2\\\\0&1\\end{bmatrix}\n$$\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>';
  const html = renderAnswer(text);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="math-block"/);
  assert.match(html, /<code class="language-js">/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
test('does not create active links from untrusted math commands', () => {
  assert.doesNotMatch(renderAnswer('$\\href{javascript:alert(1)}{click}$'), /href="javascript:/);
});

test('renders the prompted LaTeX delimiters as inline and display formulas', () => {
  const inline = String.raw`向量 \(x_i^2\) 与矩阵 \(W_q\)。`;
  const display = String.raw`\[
q = W_q x
\]`;
  const html = renderAnswer(`${inline}\n\n${display}\n\n继续解释。`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
  assert.equal((html.match(/class="math-block"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /katex-error|<code>|\\\(|\\\)|\\\[|\\\]/);
});
