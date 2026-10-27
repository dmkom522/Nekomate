export function validateEndpoint(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('API 地址必须是完整 URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或片段');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('远程 API 必须使用 HTTPS；本机服务可以使用 HTTP');
  return url.href.replace(/\/$/, '');
}
