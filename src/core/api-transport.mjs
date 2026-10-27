let sessionFetch;

// The desktop host installs session.defaultSession.fetch after Electron is ready.
// Core callers and tests can still provide their own fetch implementation.
export function setApiFetchImplementation(implementation) {
  if (implementation !== undefined && typeof implementation !== 'function') throw new TypeError('API transport must be a function');
  sessionFetch = implementation;
}

export function apiFetch(input, options) {
  return (sessionFetch ?? globalThis.fetch)(input, options);
}

export async function* responseChunks(response, signal) {
  signal?.throwIfAborted();
  if (!response.body) throw new Error('API 未返回响应内容');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      let chunk;
      try { chunk = await reader.read(); }
      catch { signal?.throwIfAborted(); throw new Error('API 响应读取中断，请重试'); }
      signal?.throwIfAborted();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readApiJson(response, { signal, limit = 2_000_000, invalidMessage = 'API 未返回有效 JSON', limitMessage = 'API 响应过大，请缩小问题范围' } = {}) {
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  for await (const chunk of responseChunks(response, signal)) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error(limitMessage);
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch { throw new Error(invalidMessage); }
}
