import { validateCourseContext } from './course-context.mjs';
import { validateNotes } from './visual-memory.mjs';
import { systemPrompt } from './prompts.mjs';
export const LIMITS = Object.freeze({ frames: 12, transcripts: 120, history: 12, imageBytes: 2_000_000 });

export function timestamp(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

function finiteTime(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error('片段时间必须是非负数字');
  return value;
}

export function validateContext(input) {
  if (!input || typeof input !== 'object') throw new Error('缺少问题和上下文');
  const question = String(input.question ?? '').trim();
  if (!question || question.length > 6000) throw new Error('请输入 1–6000 字的问题');
  const frames = input.frames ?? [];
  const transcripts = input.transcripts ?? [];
  const history = input.history ?? [];
  if (!Array.isArray(frames) || frames.length > LIMITS.frames) throw new Error('一次最多发送 12 张画面');
  if (!Array.isArray(transcripts) || transcripts.length > LIMITS.transcripts) throw new Error('转写片段过多');
  if (!Array.isArray(history) || history.length > LIMITS.history) throw new Error('对话历史过长');
  return {
    question,
    courseContext: validateCourseContext(input.courseContext),
    analyses: validateNotes(input.analyses, 18).map((note, i) => ({ ...note, id: `V${i + 1}` })),
    currentTime: input.currentTime === undefined ? null : finiteTime(input.currentTime),
    frames: frames.map((frame, i) => {
      if (typeof frame.image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(frame.image)) throw new Error('画面必须是 base64 图片');
      if (frame.image.length > LIMITS.imageBytes * 4 / 3) throw new Error('单张画面过大');
      return { id: `F${i + 1}`, time: finiteTime(frame.time), image: frame.image };
    }),
    transcripts: transcripts.map((item, i) => {
      const start = finiteTime(item.start), end = finiteTime(item.end);
      if (end < start || typeof item.text !== 'string' || item.text.length > 8000) throw new Error('转写片段格式不正确');
      return { id: `T${i + 1}`, start, end, text: item.text };
    }),
    history: history.map(item => {
      if (!['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 16000) throw new Error('对话历史格式不正确');
      return { role: item.role, content: item.content };
    }),
  };
}

export function buildMessages(context) {
  const system = systemPrompt('answer');
  const parts = [{ type: 'text', text: `问题：${context.question}\n\n本次提供 ${context.analyses.length} 段已完成的画面理解、${context.frames.length} 张抽样画面、${context.transcripts.length} 段音频转写。${context.currentTime === null ? '' : `提问时听课时间 ${timestamp(context.currentTime)}（本次会话相对时间，不是视频播放进度）。`}资料时间仅用于定位记录，不代表用户一定在问最新片段；没有明确对应的新画面时，不能把旧笔记当作当前画面。` }];
  if (context.courseContext?.text) parts.push({ type: 'text', text: `本对话已保存的课程背景（含可能的公开检索补充，只作背景，不代表当前画面、老师原话或用户所指片段）：\n${context.courseContext.text}` });
  for (const note of context.analyses) parts.push({ type: 'text', text: `[${note.id}] 听课时间 ${timestamp(note.time)}，窗口 ${note.source}，画面理解笔记（可能有识别错误）：\n${note.text}` });
  for (const frame of context.frames) {
    parts.push({ type: 'text', text: `[${frame.id}] ${frame.time === context.currentTime ? '提问时的新截图，' : ''}听课时间 ${timestamp(frame.time)}` });
    parts.push({ type: 'image_url', image_url: { url: frame.image } });
  }
  for (const item of context.transcripts) parts.push({ type: 'text', text: `[${item.id}] 听课时间 ${timestamp(item.start)}–${timestamp(item.end)}，自动转写（可能有识别错误）：\n${item.text}` });
  return [{ role: 'system', content: system }, ...context.history, { role: 'user', content: parts }];
}

export function sourcesOf(context) {
  return [
    ...context.analyses.map(({ id, time, text }) => ({ id, type: 'visual-note', time, text })),
    ...context.frames.map(({ id, time }) => ({ id, type: 'frame', time })),
    ...context.transcripts.map(({ id, start, end, text }) => ({ id, type: 'transcript', start, end, text })),
  ];
}
