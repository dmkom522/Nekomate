import MarkdownIt from 'markdown-it';
import katex from 'katex';

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
const math = (text, displayMode) => katex.renderToString(text, { displayMode, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20, output: 'htmlAndMathml' });
markdown.inline.ruler.before('escape', 'deskmate_math', (state, silent) => {
  const start = state.pos;
  const delimiter = state.src.startsWith('\\(', start) ? '\\(' : state.src[start] === '$' && state.src[start + 1] !== '$' ? '$' : null;
  if (!delimiter) return false;
  const closing = delimiter === '$' ? '$' : '\\)';
  let end = state.src.indexOf(closing, start + delimiter.length);
  while (end > 0 && state.src[end - 1] === '\\' && closing === '$') end = state.src.indexOf(closing, end + 1);
  if (end < 0 || end === start + delimiter.length) return false;
  const content = state.src.slice(start + delimiter.length, end);
  if (content.includes('\n') || (delimiter === '$' && (/^\s/.test(content) || /\s$/.test(content)))) return false;
  if (!silent) { const token = state.push('math_inline', '', 0); token.content = content; }
  state.pos = end + closing.length; return true;
});
markdown.renderer.rules.math_inline = (tokens, index) => math(tokens[index].content, false);
markdown.block.ruler.before('fence', 'deskmate_math_block', (state, start, end, silent) => {
  const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]).trim();
  const delimiter = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null;
  if (!delimiter) return false;
  const closing = delimiter === '$$' ? '$$' : '\\]';
  if (silent) return true;
  let line = start, content = first.slice(delimiter.length), ended = content.endsWith(closing);
  if (ended) content = content.slice(0, -closing.length);
  while (!ended && ++line < end) {
    const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    ended = text.trimEnd().endsWith(closing);
    content += '\n' + (ended ? text.trimEnd().slice(0, -closing.length) : text);
  }
  if (!ended) return false;
  const token = state.push('math_block', '', 0); token.content = content; token.block = true;
  state.line = line + 1; return true;
});
markdown.renderer.rules.math_block = (tokens, index) => `<div class="math-block">${math(tokens[index].content, true)}</div>`;

export function renderAnswer(text) { return markdown.render(text); }
