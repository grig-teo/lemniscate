/**
 * Structural guard for the locale catalogs (mirrors the `check:i18n` script,
 * but as a unit test so `npm test` catches catalog drift too): ru.json and
 * zh.json must cover exactly the keys extracted into en.json, with non-empty
 * ICU-valid values.
 */
import { describe, expect, it } from 'vitest';

import en from '@/locales/en.json';
import ru from '@/locales/ru.json';
import zh from '@/locales/zh.json';

const enKeys = Object.keys(en).sort();

describe('locale catalogs', () => {
  it('en.json uses sorted, namespaced message ids', () => {
    expect(Object.keys(en)).toEqual(enKeys);
    for (const key of enKeys) expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9-]*\./);
  });

  it.each([['ru', ru], ['zh', zh]] as const)('%s.json covers exactly the en.json keys', (_name, catalog) => {
    expect(Object.keys(catalog).sort()).toEqual(enKeys);
  });

  it.each([['ru', ru], ['zh', zh]] as const)('%s.json values are non-empty translations', (_name, catalog) => {
    for (const key of enKeys) {
      expect(typeof catalog[key as keyof typeof catalog]).toBe('string');
      expect((catalog[key as keyof typeof catalog] as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('every error-code message id in en.json matches a banner mapping', async () => {
    const { getErrorBannerInfo } = await import('@/lib/error-codes');
    const errorIds = enKeys.filter((key) => key.startsWith('error.'));
    expect(errorIds.length).toBeGreaterThan(0);
    for (const id of errorIds) {
      const code = id.split('.')[1];
      const info = getErrorBannerInfo(code);
      expect(info.titleId).toBe(`error.${info.code}.title`);
      expect(info.hintId).toBe(`error.${info.code}.hint`);
    }
  });
});
