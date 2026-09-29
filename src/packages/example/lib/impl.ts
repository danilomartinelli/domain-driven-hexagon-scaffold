export function tokenizeUnique(input: string): string[] {
  const normalized = input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)];
}
