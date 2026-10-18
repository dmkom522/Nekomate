import { buildMessages, sourcesOf, validateContext } from './context.mjs';

export function validateEndpoint(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('API 地址必须是完整 URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('远程 API 必须使用 HTTPS；本机服务可以使用 HTTP');
  return url.href.replace(/\/$/, '');
}

export function normalizeConfig(input, previous = {}) {
  const result = {};
  for (const name of ['vision', 'speech']) {
    const item = input[name] ?? {}, old = previous[name] ?? {};
    const baseUrl = item.baseUrl === undefined ? (old.baseUrl ?? '') : String(item.baseUrl).trim();
    const model = item.model === undefined ? (old.model ?? '') : String(item.model).trim();
    if (model.length > 200) throw new Error('模型名称过长');
    const apiKey = item.clearKey ? '' : (item.apiKey ? String(item.apiKey).trim() : (old.apiKey ?? ''));
    if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式不正确');
    result[name] = { baseUrl: baseUrl ? validateEndpoint(baseUrl) : '', model, apiKey };
  }
  result.transcribe = Boolean(input.transcribe ?? previous.transcribe ?? false);
  return result;
}

export function publicConfig(config) {
  return {
    vision: { baseUrl: config.vision.baseUrl, model: config.vision.model, hasKey: Boolean(config.vision.apiKey) },
    speech: { baseUrl: config.speech.baseUrl, model: config.speech.model, hasKey: Boolean(config.speech.apiKey) },
    transcribe: config.transcribe,
  };
}

export function configFromEnv(env = process.env) {
  return normalizeConfig({
    vision: { baseUrl: env.VISION_BASE_URL ?? 'https://api.openai.com/v1', model: env.VISION_MODEL ?? '', apiKey: env.VISION_API_KEY ?? '' },
    speech: { baseUrl: env.SPEECH_BASE_URL ?? '', model: env.SPEECH_MODEL ?? '', apiKey: env.SPEECH_API_KEY ?? '' },
    transcribe: env.AUTO_TRANSCRIBE === 'true',
  });
}

function ensureConfigured(config, name) {
  if (!config?.baseUrl || !config?.model) throw new Error(`请先配置${name}的 API 地址和模型名称`);
}

async function providerRequest(config, path, body, signal, fetchImpl = fetch) {
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}${path}`, {
      method: 'POST', headers, body: body instanceof FormData ? body : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      redirect: 'error',
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('请求已取消');
    if (error.name === 'TimeoutError') throw new Error('API 请求超过 90 秒，请检查服务状态后重试');
    throw new Error('无法连接 API，请检查地址、网络和本地代理设置');
  }
  if (!response.ok) {
    // Never echo an upstream response: some gateways include credentials or request bodies.
    const hints = { 400: '请求格式或模型能力不匹配，请确认支持图片输入', 401: 'API Key 无效', 403: '服务拒绝访问', 404: '接口地址或模型不存在', 413: '上下文过大，请减少画面', 429: '额度不足或请求过于频繁' };
    throw new Error(`API 返回 ${response.status}：${hints[response.status] ?? '服务请求失败，请稍后重试'}`);
  }
  try { return await response.json(); } catch { throw new Error('API 未返回有效 JSON'); }
}

export async function answerQuestion(config, input, signal, fetchImpl) {
  ensureConfigured(config.vision, '视觉模型');
  const context = validateContext(input);
  const data = await providerRequest(config.vision, '/chat/completions', {
    model: config.vision.model, messages: buildMessages(context), stream: false,
  }, signal, fetchImpl);
  const content = data.choices?.[0]?.message?.content;
  const answer = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
  if (!answer.trim()) throw new Error('模型没有返回文字回答，请检查模型和接口兼容性');
  return { answer, sources: sourcesOf(context), usage: data.usage ?? null, model: config.vision.model };
}

export async function transcribeAudio(config, bytes, mimeType, signal, fetchImpl) {
  ensureConfigured(config.speech, '语音转写');
  if (!['audio/webm', 'audio/ogg', 'audio/mp4'].includes(mimeType)) throw new Error('不支持的音频格式');
  if (!bytes.length || bytes.length > 12_000_000) throw new Error('音频大小必须在 1 字节到 12 MB 之间');
  const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4' }[mimeType];
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), `segment.${ext}`);
  form.append('model', config.speech.model);
  form.append('response_format', 'json');
  const data = await providerRequest(config.speech, '/audio/transcriptions', form, signal, fetchImpl);
  if (typeof data.text !== 'string') throw new Error('转写接口没有返回 text 字段');
  return { text: data.text };
}
