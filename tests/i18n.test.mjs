import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ENGLISH, normalizeLanguage, translate, translateMessage } from '../src/core/i18n.mjs';
import { setLanguage, getLanguage, t, applyTranslations } from '../src/renderer/i18n.mjs';

test('language normalization defaults to Chinese and accepts only offered languages', () => {
  assert.equal(normalizeLanguage(), 'zh-CN');
  assert.equal(normalizeLanguage('en'), 'en');
  for (const value of ['en-US', '', null, {}, 'zh']) assert.throws(() => normalizeLanguage(value), /语言/);
});

test('every marked static interface string has a non-Chinese English translation', async () => {
  const html = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-(?:placeholder|title|aria-label))?="([^"]+)"/g)].map(match => match[1]);
  assert.ok(keys.length > 60);
  for (const key of keys) {
    assert.ok(Object.hasOwn(ENGLISH, key), `Missing static translation: ${key}`);
    assert.doesNotMatch(translate(key, 'en'), /\p{Script=Han}/u, key);
  }
});

test('UI templates keep user names intact and errors preserve status without echoing unknown Chinese text', () => {
  assert.equal(translate('显示更早的消息（还有 42 条）', 'en'), 'Show earlier messages (42 more)');
  assert.equal(translate('管理对话：我的课程', 'en'), 'Manage conversation: 我的课程');
  assert.equal(translate('自定义模型（上次选择）', 'en'), '自定义模型 (previous selection)');
  assert.equal(translate('API 返回 401：API Key 无效', 'en'), 'API returned 401: Invalid API key');
  assert.equal(translate('API 返回 429：额度不足或请求过于频繁', 'en'), 'API returned 429: Quota exceeded or too many requests');
  assert.match(translate('画面读取已暂停：请求已取消。再次发送问题可重试。', 'en'), /Request cancelled/);
  assert.equal(translate('A user-written 中文 title', 'en'), 'A user-written 中文 title');
  assert.doesNotMatch(translateMessage('未知错误 sk-test-secret', 'en'), /sk-test-secret|未知/);
  assert.equal(translateMessage('Request cancelled', 'en'), 'Request cancelled');
  assert.equal(translate('选择模型', 'zh-CN'), '选择模型');
});

test('dynamic app UI copy has English catalog coverage', async () => {
  const source = await readFile(new URL('../src/renderer/app.mjs', import.meta.url), 'utf8');
  const literals = [...source.matchAll(/'((?:\\.|[^'\\\r\n])*)'/g)].map(match => match[1]).filter(value => /\p{Script=Han}/u.test(value));
  assert.ok(literals.length > 70);
  for (const value of literals) assert.notEqual(translate(value, 'en'), value, `Untranslated app copy: ${value}`);
});

test('saved localized errors can return to Chinese without reversing ordinary UI or arbitrary English', () => {
  const controlled = [
    '请求已取消',
    'API 返回 401：API Key 无效',
    'API 返回 429：额度不足或请求过于频繁',
    '音频读取失败：本地语音转写超时，请重试',
    '语音转写失败，本次将结合画面和已有记录回答：音频读取失败：本地语音转写超时，请重试',
    '待处理截图格式无效',
    '待处理截图保存失败，已暂停新增截图，请检查磁盘空间。',
    '待处理截图无法读取，文件仍保留。',
    '待处理截图编号无效',
    '画面读取已暂停：请求已取消。再次发送问题可重试。',
    '回答已停止显示，会话同步未完成：API 返回 401：API Key 无效。下次提问前会先恢复会话。',
    '启动失败：请求已取消',
    '读取模型失败（403），请检查地址、密钥和模型列表接口',
  ];
  for (const original of controlled) {
    const english = translateMessage(original, 'en');
    assert.notEqual(english, original);
    assert.equal(translateMessage(english, 'zh-CN'), original);
    assert.equal(translateMessage(original, 'zh-CN'), original);
  }
  const unknown = 'ECONNRESET while reading socket example:443';
  assert.equal(translateMessage(unknown, 'zh-CN'), unknown);
  assert.equal(translateMessage('Audio could not be read: ECONNRESET', 'zh-CN'), '音频读取失败：ECONNRESET');
  assert.equal(translate('Request cancelled', 'zh-CN'), 'Request cancelled');
  setLanguage('zh-CN');
  assert.equal(t('API settings'), 'API settings');
  assert.equal(translateMessage(translateMessage('未知错误 sk-secret', 'en'), 'zh-CN'), '操作未能完成，请检查设置后重试。');
});

test('renderer applies only explicit owned UI attributes and preserves user content', () => {
  const element = (attributes, text = '') => ({ attributes: new Map(Object.entries(attributes)), textContent: text,
    hasAttribute(key) { return this.attributes.has(key); }, getAttribute(key) { return this.attributes.get(key) ?? null; },
    setAttribute(key, value) { this.attributes.set(key, value); } });
  const label = element({ 'data-i18n': 'API 设置' }, 'API 设置');
  const input = element({ 'data-i18n-placeholder': '你的问题', 'data-i18n-aria-label': '你的问题' });
  const user = element({}, '用户写的中文资料');
  const root = { querySelectorAll: () => [label, input] };
  setLanguage('en'); applyTranslations(root);
  assert.equal(getLanguage(), 'en'); assert.equal(t('选择模型'), 'Choose model');
  assert.equal(label.textContent, 'API settings');
  assert.equal(input.getAttribute('placeholder'), 'Your question');
  assert.equal(user.textContent, '用户写的中文资料');
  setLanguage('zh-CN'); applyTranslations(root);
  assert.equal(label.textContent, 'API 设置');
});
