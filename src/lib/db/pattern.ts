export function containsPattern(term: string): string {
  return `%${term.trim().replace(/[\\%_*]/g, (c) => `\\${c}`)}%`;
}
