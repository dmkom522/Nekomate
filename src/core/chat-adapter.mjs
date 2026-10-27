function parts(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

export function chatRequest(config, messages, { fastMode } = {}) {
  if ((config.protocol ?? 'openai') === 'openai') return {
    path: '/chat/completions', headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: { model: config.model, messages, stream: false, ...(fastMode?.type === 'openai' ? { service_tier: fastMode.tier } : {}) },
  };
  const system = messages.filter(m => m.role === 'system').map(m => parts(m.content).map(p => p.text ?? '').join('\n')).join('\n\n');
  return {
    path: '/messages', headers: { 'anthropic-version': '2023-06-01', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}), ...(fastMode?.beta ? { 'anthropic-beta': fastMode.beta } : {}) },
    body: {
      model: config.model, max_tokens: 4096, system, stream: false, ...(fastMode?.type === 'anthropic' ? { speed: 'fast' } : {}),
      messages: messages.filter(m => m.role !== 'system').map(message => ({
        role: message.role,
        content: parts(message.content).map(part => {
          if (part.type === 'text') return part;
          const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url?.url ?? '');
          if (!match) throw new Error('图片格式不受支持');
          return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
        }),
      })),
    },
  };
}

export function chatText(config, data) {
  const content = config.protocol === 'anthropic' ? data.content : data.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
}

export function assertCompletionReason(protocol, reason) {
  if (reason == null) return; // Some compatible JSON endpoints omit this field.
  if (reason === 'length' || reason === 'max_tokens' || reason === 'model_context_window_exceeded') throw new Error('回答达到模型输出上限，请缩小问题范围后重试');
  if (reason === 'content_filter') throw new Error('服务限制了这次回答，未能完整输出');
  const complete = protocol === 'anthropic' ? ['end_turn', 'stop_sequence', 'refusal'] : ['stop'];
  if (!complete.includes(reason)) throw new Error('模型未完成文字回答，请重试');
}
