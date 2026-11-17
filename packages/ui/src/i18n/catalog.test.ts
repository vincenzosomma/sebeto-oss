import { describe, expect, it } from 'vitest';
import { CATALOG, detectLocale, translate } from './catalog';
import { formatCost, formatRelative } from '../lib/format';

describe('i18n', () => {
  it('fills placeholders', () => {
    expect(translate('en', 'header.summary', { working: 2, waiting: 3 })).toBe('2 agents working · 3 waiting for you');
    expect(translate('it', 'new.created', { number: 110, column: 'Da fare' })).toBe('Creato T-110 in Da fare.');
  });
  it('keeps unknown placeholders', () => {
    expect(translate('en', 'header.summary', { working: 1 })).toBe('1 agents working · {waiting} waiting for you');
  });
  it('has the same keys in every locale', () => {
    expect(Object.keys(CATALOG.it).sort()).toEqual(Object.keys(CATALOG.en).sort());
  });
  it('detects the locale from navigator.language', () => {
    expect(detectLocale('it-IT')).toBe('it');
    expect(detectLocale('en-GB')).toBe('en');
    expect(detectLocale('de')).toBe('en');
    expect(detectLocale(undefined)).toBe('en');
  });
});

describe('format', () => {
  it('formats costs in USD', () => {
    expect(formatCost(0.38, 'en')).toBe('$0.38');
    expect(formatCost(0.002, 'en')).toBe('< $0.01');
    expect(formatCost(0, 'en')).toBe('$0.00');
  });
  it('formats relative times', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(formatRelative('2026-11-08T11:58:00Z', 'en', now)).toMatch(/2 min/);
    expect(formatRelative('2026-11-08T11:59:50Z', 'en', now)).toBe('now');
    expect(formatRelative('garbage', 'en', now)).toBe('');
  });
});
