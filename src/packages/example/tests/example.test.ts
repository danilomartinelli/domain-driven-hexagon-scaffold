import { expect, test } from 'bun:test';
import { searchTerms } from '../index';

test('search terms normalize accents, case and separators while retaining order', () => {
  expect(searchTerms('  Café, CAFÉ! São-Paulo 2026; são  ')).toEqual([
    'cafe',
    'sao',
    'paulo',
    '2026',
  ]);
});

test('empty or punctuation-only input produces no search terms', () => {
  expect(searchTerms('')).toEqual([]);
  expect(searchTerms('  —!? ')).toEqual([]);
});
