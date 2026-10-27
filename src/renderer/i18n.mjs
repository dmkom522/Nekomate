import { normalizeLanguage, translate, translateMessage } from '../core/i18n.mjs';
let language = 'zh-CN';
export const getLanguage = () => language;
export function setLanguage(value) {
  language = normalizeLanguage(value);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  return language;
}
export const t = text => translate(text, language);
export const localizeMessage = text => translateMessage(text, language);
export function applyTranslations(root = document) {
  const selector = '[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria-label]';
  const elements = [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
  for (const element of elements) {
    if (element.hasAttribute('data-i18n')) element.textContent = t(element.getAttribute('data-i18n'));
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const key = element.getAttribute(`data-i18n-${attribute}`);
      if (key !== null) element.setAttribute(attribute, t(key));
    }
  }
}
