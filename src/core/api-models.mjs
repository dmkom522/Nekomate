import { validateEndpoint } from './endpoint.mjs';
import { supportsPurpose } from './model-capabilities.mjs';
import { apiFetch, readApiJson } from './api-transport.mjs';
import { fastModeOption } from './fast-capabilities.mjs';

export async function listApiModels(config, { target = 'vision', signal, fetchImpl = apiFetch } = {}) {
  if (!['vision', 'audio', 'speech'].includes(target)) throw new Error('模型用途无效');
  const baseUrl = validateEndpoint(config.baseUrl);
  const anthropic = config.protocol === 'anthropic';
  const headers = anthropic ? { 'anthropic-version': '2023-06-01', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}) } : config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  const rows = new Map(), seen = new Set();
  let cursor;
  const deadline = AbortSignal.timeout(20000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const transportError = error => {
    if (signal?.aborted) return new Error('请求已取消');
    if (deadline.aborted || error?.name === 'TimeoutError') return new Error('读取模型超过 20 秒，请检查服务后重试');
    return null;
  };
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${baseUrl}/models`);
    if (cursor) url.searchParams.set(anthropic ? 'after_id' : 'after', cursor);
    let response;
    try {
      requestSignal.throwIfAborted();
      response = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: requestSignal });
    } catch (error) { throw transportError(error) ?? new Error('无法读取模型列表，请检查地址、网络后重试'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`读取模型失败（${response.status}），请检查地址、密钥和模型列表接口`);
    }
    let data;
    try {
      data = await readApiJson(response, { signal: requestSignal, invalidMessage: '服务未返回有效模型列表', limitMessage: '模型列表过大，请使用更具体的服务地址' });
    } catch (error) { throw transportError(error) ?? error; }
    if (!data || !Array.isArray(data.data)) throw new Error('该服务不支持兼容的模型列表接口');
    for (const entry of data.data) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 200 || /[\x00-\x1f]/.test(entry.id)) continue;
      const endpoints = entry.supported_endpoints ?? entry.supportedEndpoints;
      if (Array.isArray(endpoints) && endpoints.some(value => typeof value !== 'string')) continue;
      let transport;
      if (target === 'audio') {
        transport = supportsPurpose(entry, 'audio-input') ? 'chat' : supportsPurpose(entry, 'speech') ? 'transcription' : '';
        if (!transport) continue;
      } else if (!supportsPurpose(entry, target)) continue;
      const display = entry.display_name ?? entry.name;
      const fastMode = fastModeOption(entry, config);
      const audioTransport = !anthropic && (supportsPurpose(entry, 'audio-input') ? 'chat' : supportsPurpose(entry, 'speech') ? 'transcription' : '');
      rows.set(entry.id, { id: entry.id, label: typeof display === 'string' && display.trim() ? display.slice(0, 200) : entry.id, isDefault: false,
        ...(target === 'audio' ? { transport } : {}), ...(target === 'vision' && audioTransport ? { audioTransport } : {}), ...(target === 'vision' && fastMode ? { fastMode } : {}) });
    }
    if (!data.has_more) return { models: [...rows.values()], source: 'api' };
    cursor = data.last_id ?? data.data.at(-1)?.id;
    if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('模型列表分页异常');
    seen.add(cursor);
  }
  throw new Error('模型列表页数过多，请使用更具体的服务地址');
}
