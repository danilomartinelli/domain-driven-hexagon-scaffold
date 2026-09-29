import { tokenizeUnique } from './lib/impl';

/** Return distinct, accent-insensitive search terms in first-occurrence order. */
export function searchTerms(input: string): string[] {
  return tokenizeUnique(input);
}
