// Conservative fallback for catalogs without capability fields. Unknown IDs stay hidden.
// Explicit endpoint/modality metadata always takes precedence over these documented families.
export function supportsPurpose(entry, purpose = 'vision', { cli = false } = {}) {
  const id = String(entry.model ?? entry.id ?? entry.value ?? '').toLowerCase();
  if (entry.hidden) return false;
  const endpoints = entry.supported_endpoints ?? entry.supportedEndpoints;
  const endpoint = purpose === 'speech' ? '/audio/transcriptions' : '/chat/completions';
  if (!cli && Array.isArray(endpoints) && !endpoints.some(value => value.endsWith(endpoint) || (purpose === 'vision' && value.endsWith('/messages')))) return false;
  if (purpose === 'speech') {
    const flag = entry.capabilities?.transcription?.supported;
    if (typeof flag === 'boolean') return flag;
    if (Array.isArray(endpoints)) return endpoints.some(value => value.endsWith('/audio/transcriptions'));
    return /^(whisper-1|gpt-transcribe|gpt-4o(?:-mini)?-transcribe)(?:-\d{4}-\d{2}-\d{2})?$/.test(id);
  }
  if (purpose === 'audio-input') {
    const flag = entry.capabilities?.audio_input?.supported;
    if (typeof flag === 'boolean') return flag;
    const modalities = entry.inputModalities ?? entry.input_modalities ?? entry.architecture?.input_modalities;
    if (Array.isArray(modalities)) return modalities.includes('audio');
    return false;
  }
  const flag = entry.capabilities?.image_input?.supported;
  if (typeof flag === 'boolean') return flag;
  const modalities = entry.inputModalities ?? entry.input_modalities ?? entry.architecture?.input_modalities;
  if (Array.isArray(modalities)) return modalities.includes('image');
  if (/(audio|realtime|transcribe|embedding|moderation|image|tts|deep-research)/.test(id)) return false;
  if (!cli && /(codex|(?:^|-)pro(?:-|$))/.test(id) && id.startsWith('gpt')) return false;
  return /^gpt-(?:6(?:\.1)?-(?:sol|astra|luna)|5\.6-(?:sol|terra|luna))(?:-\d{4}-\d{2}-\d{2})?$/.test(id)
    || /^(gpt-4o(?:-mini)?|gpt-4\.1(?:-mini|-nano)?|gpt-5(?:\.[12456])?(?:-mini|-nano|-chat-latest)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(id)
    || /^claude-(?:(?:3(?:-5|-7)?)-(?:sonnet|opus|haiku)|(?:sonnet|opus|haiku)-(?:4|5))(?:[.-][a-z0-9-]+)?$/.test(id)
    || (cli && /^(sonnet|opus|haiku)$/.test(id))
    || /^(deepseek-flash|deepseek-v4-flash-vision-exp)$/.test(id);
}
