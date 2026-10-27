import { listApiModels } from './api-models.mjs';
import { listCliModels } from './cli-models.mjs';
import { apiFetch } from './api-transport.mjs';

const scopes = new WeakMap();
export async function selectedFastMode(config, signal, fetchImpl = apiFetch) {
  if (config.fastMode !== true) return null;
  const model = config.mode === 'cli' ? config.cli.model : config.vision.model;
  const key = JSON.stringify(config.mode === 'cli'
    ? ['cli', config.cli.kind, config.cli.path, model]
    : ['api', config.vision.provider, config.vision.protocol, config.vision.baseUrl, config.vision.apiKey, model]);
  let cache = scopes.get(fetchImpl); if (!cache) { cache = new Map(); scopes.set(fetchImpl, cache); }
  signal?.throwIfAborted();
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.option;
  const catalog = config.mode === 'cli' ? await listCliModels(config.cli, { signal }) : await listApiModels(config.vision, { signal, fetchImpl });
  signal?.throwIfAborted();
  const option = catalog.models.find(row => row.id === model)?.fastMode;
  if (!option) throw new Error('当前模型未确认支持快速模式，请关闭闪电开关或刷新模型列表');
  if (cache.size >= 32) cache.delete(cache.keys().next().value);
  cache.set(key, { option, expires: Date.now() + 60_000 });
  return option;
}
