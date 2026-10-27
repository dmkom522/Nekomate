import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, publicConfig } from '../src/core/provider.mjs';

test('UI language defaults to Chinese and persists independently of model credentials and options', () => {
  const initial = normalizeConfig({ mode: 'api', vision: { provider: 'custom', baseUrl: 'https://example.com/v1', model: 'vision', apiKey: 'private-key' }, fastMode: true, transcription: { useSelectedModel: true } });
  assert.equal(initial.language, 'zh-CN');
  const english = normalizeConfig({ language: 'en' }, initial);
  assert.equal(english.language, 'en');
  assert.deepEqual(english.vision, initial.vision);
  assert.deepEqual(english.cli, initial.cli);
  assert.deepEqual(english.transcription, initial.transcription);
  assert.equal(english.fastMode, true);
  assert.equal(publicConfig(english).language, 'en');
  assert.equal(publicConfig(english).vision.apiKey, undefined);
  assert.equal(normalizeConfig({ vision: { model: 'other' } }, english).language, 'en');
  assert.equal(normalizeConfig({}, { language: 'en' }).language, 'en');
});

test('language selection works before model setup and survives removal of an obsolete provider', () => {
  const empty = normalizeConfig({ language: 'en' });
  assert.equal(empty.language, 'en');
  assert.equal(empty.vision.model, '');
  assert.equal(normalizeConfig({ language: 'zh-CN' }, empty).language, 'zh-CN');
  assert.equal(normalizeConfig({ language: 'en', vision: { provider: 'kimi' } }).language, 'en');
  assert.throws(() => normalizeConfig({ language: 'invalid' }), /语言|language/i);
});
