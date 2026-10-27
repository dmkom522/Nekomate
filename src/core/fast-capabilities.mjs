// Fast is a provider processing tier, not reduced reasoning or a different model.
export function fastModeOption(entry, { mode = 'api', kind, protocol = 'openai', baseUrl = '' } = {}) {
  const supported = entry.supportsFastMode ?? entry.capabilities?.fast_mode?.supported;
  if (supported === false) return null;
  const tiers = entry.serviceTiers ?? entry.service_tiers ?? entry.supported_service_tiers;
  const tier = Array.isArray(tiers) ? tiers.find(value => {
    const id = typeof value === 'string' ? value : value?.id;
    return ['fast', 'priority'].includes(id);
  }) : null;
  const tierId = typeof tier === 'string' ? tier : tier?.id;
  if (mode === 'cli' && kind === 'codex') return tierId ? { type: 'codex', tier: tierId } : null;
  const id = String(entry.model ?? entry.id ?? entry.value ?? '').toLowerCase();
  const claude = /^claude-opus-(?:5-5|5|4-8)(?:-\d{8})?$/.test(id);
  if (mode === 'cli') return kind === 'claude' && (supported === true || claude) ? { type: 'claude' } : null;
  let host; try { host = new URL(baseUrl).hostname; } catch { return null; }
  if (protocol === 'anthropic') {
    if (supported !== true && !(host === 'api.anthropic.com' && claude)) return null;
    return { type: 'anthropic', ...(id.startsWith('claude-opus-5-5') ? {} : { beta: 'fast-mode-2026-02-01' }) };
  }
  if (protocol !== 'openai') return null;
  if (tierId) return { type: 'openai', tier: tierId };
  if (Array.isArray(tiers)) return null; // Explicit capability exclusions win.
  if (host === 'api.openai.com' && /^gpt-(?:6(?:\.1)?-(?:astra|sol|luna)|5\.6-(?:sol|terra|luna)|5\.(?:4|5))(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) return { type: 'openai', tier: 'priority' };
  return null;
}
