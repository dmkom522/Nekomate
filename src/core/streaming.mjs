import { responseChunks } from './api-transport.mjs';
import { assertCompletionReason } from './chat-adapter.mjs';

export async function readChatStream(response, protocol, onDelta, { signal, allowToolCalls = false } = {}) {
  const decoder = new TextDecoder();
  let buffer = '', text = '', complete = false, terminal = false, usage = null, bytes = 0;
  let reasoningContent = '', finishReason;
  const calls = new Map();
  const event = block => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      if (protocol === 'anthropic') throw new Error('流式响应格式不正确');
      complete = true; terminal = true; return;
    }
    let value; try { value = JSON.parse(data); } catch { throw new Error('流式响应格式不正确'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('流式响应格式不正确');
    if (value.error || value.type === 'error') throw new Error('模型输出中断，请重试');
    let delta;
    if (protocol === 'anthropic') {
      if (value.type === 'message_delta') assertCompletionReason(protocol, value.delta?.stop_reason);
      if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta') delta = value.delta.text;
      if (value.type === 'message_stop') { complete = true; terminal = true; }
    } else {
      delta = value.choices?.[0]?.delta?.content;
      const change = value.choices?.[0]?.delta, reason = value.choices?.[0]?.finish_reason;
      if (allowToolCalls) {
        if (typeof change?.reasoning_content === 'string') {
          reasoningContent += change.reasoning_content;
          if (reasoningContent.length > 200000) throw new Error('模型推理内容过长');
        }
        for (const part of change?.tool_calls ?? []) {
          if (!Number.isInteger(part.index) || part.index < 0 || part.index > 7) throw new Error('网页工具调用格式不正确');
          const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.type && part.type !== 'function') throw new Error('不支持的工具类型');
          if (part.id) call.id += part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
          if (call.id.length > 200 || call.function.name.length > 100 || call.function.arguments.length > 10000) throw new Error('网页工具调用过大');
          calls.set(part.index, call);
        }
      }
      if (reason === 'tool_calls' && allowToolCalls) complete = true;
      else assertCompletionReason(protocol, reason);
      if (reason === 'stop') complete = true;
      if (reason) finishReason = reason;
    }
    if (value.usage) usage = value.usage;
    if (typeof delta === 'string' && delta) {
      text += delta;
      if (text.length > 64000) throw new Error('回答过长，请缩小问题范围');
      onDelta(delta);
    }
  };
  for await (const chunk of responseChunks(response, signal)) {
    bytes += chunk.byteLength;
    if (bytes > 2_000_000) throw new Error('流式响应过大');
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    if (buffer.length > 1_000_000) throw new Error('流式响应过大');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      event(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      if (terminal) break;
    }
    if (terminal) break;
  }
  if (!terminal) { buffer += decoder.decode(); if (buffer.trim()) event(buffer); }
  if (!complete) throw new Error('连接提前结束，回答未完成');
  if (allowToolCalls && calls.size && finishReason !== 'tool_calls') throw new Error('网页工具调用未完成');
  if (allowToolCalls && finishReason === 'tool_calls' && !calls.size) throw new Error('网页工具调用为空');
  return { text, usage, ...(allowToolCalls ? { toolCalls: [...calls].sort(([a], [b]) => a - b).map(([, call]) => call), reasoningContent, finishReason } : {}) };
}

export function jsonLines(onEvent) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (line) onEvent(JSON.parse(line));
    }
  };
}
