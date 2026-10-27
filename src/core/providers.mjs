// Endpoints are editable. Model IDs stay user supplied because availability varies by account.
export const PROVIDERS = Object.freeze({
  openai: { label: 'OpenAI', cli: 'codex', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { label: 'DeepSeek', apiOnly: true, protocol: 'openai', baseUrl: 'https://api.deepseek.com' },
  claude: { label: 'Claude / Anthropic', cli: 'claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  custom: { label: '其他服务 / 本地 API', protocol: 'openai', baseUrl: '' },
});

export function inferProvider(baseUrl) {
  return Object.entries(PROVIDERS).find(([key, value]) => key !== 'custom' && value.baseUrl === baseUrl?.replace(/\/$/, ''))?.[0] ?? 'custom';
}

export function modelReady(config) {
  return config?.mode === 'cli' ? Boolean(config.cli?.model) : Boolean(config?.vision?.baseUrl && config?.vision?.model);
}
