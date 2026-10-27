const origins = {
  codex: 'https://chatgpt.com', claude: 'https://api.anthropic.com',
};
let systemProxy;

export function setSystemProxyResolver(resolve) { systemProxy = resolve; }

export async function cliEnvironment(kind, source = process.env) {
  const env = { ...source };
  // Explicit terminal or application proxy settings take precedence.
  if (Object.keys(env).some(key => /^(https?_proxy|all_proxy)$/i.test(key) && env[key])) return env;
  if (!systemProxy) return env;
  let result;
  try { result = await systemProxy(origins[kind] ?? origins.codex); } catch { return env; }
  const first = String(result).split(';')[0].trim();
  const match = /^(PROXY|HTTPS)\s+(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/.exec(first);
  if (!match || Number(match[3]) > 65535 || Number(match[3]) === 0) return env;
  const proxy = `${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}:${match[3]}`;
  env.HTTPS_PROXY = proxy; env.HTTP_PROXY = proxy;
  return env;
}
