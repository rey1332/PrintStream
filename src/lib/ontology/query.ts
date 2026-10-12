import { ONTOLOGY, isOntologyType, type OntologyTypeKey } from './registry';

export const SEARCH_LIMITS = {
  maxQueryLength: 100,
  maxWords: 5,
  minMultiTypeLength: 3,
  groupRows: 5,
  pageRows: 20,
  maxOffset: 5000,
  countCap: 100,
  relatedRows: 10,
} as const;

export interface ParsedQuery {
  patterns: string[];
  idRange: { from: string; to: string } | null;
  number: number | null;
}

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const REF = /^(?:[a-z]{2,3}-)?#?([0-9a-f]{4,8}(?:-?[0-9a-f]{1,24})?)$/i;
const NUMBER = /^(?:je-?|#)?(\d{1,9})$/i;

export function idPrefixRange(hex: string): { from: string; to: string } | null {
  const digits = hex.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{4,32}$/.test(digits)) return null;
  const pad = (fill: string) => {
    const full = (digits + fill.repeat(32)).slice(0, 32);
    return `${full.slice(0, 8)}-${full.slice(8, 12)}-${full.slice(12, 16)}-${full.slice(16, 20)}-${full.slice(20)}`;
  };
  return { from: pad('0'), to: pad('f') };
}

export function parseQuery(input: string): ParsedQuery {
  const words = input.trim().split(/\s+/).filter(Boolean).slice(0, SEARCH_LIMITS.maxWords);
  let idRange: ParsedQuery['idRange'] = null;
  let number: number | null = null;
  for (const word of words) {
    const ref: RegExpExecArray | null = idRange ? null : REF.exec(word);
    if (ref) idRange = idPrefixRange(ref[1]);
    const num: RegExpExecArray | null = number === null ? NUMBER.exec(word) : null;
    if (num) number = Number(num[1]);
  }
  return { patterns: words.map((w) => `%${escapeLike(w)}%`), idRange, number };
}

export interface SearchRequest {
  q: string;
  types: OntologyTypeKey[];
  statuses: string[] | null;
  dateFrom: string | null;
  dateTo: string | null;
  offset: number;
}

export type SearchValidation = { ok: true; request: SearchRequest } | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown) =>
  typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function validateSearch(body: unknown): SearchValidation {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const q = typeof b.q === 'string' ? b.q.trim() : '';
  if (q.length > SEARCH_LIMITS.maxQueryLength) return { ok: false, error: 'queryTooLong' };

  const rawTypes = Array.isArray(b.types) ? b.types : [];
  if (rawTypes.length === 0 || rawTypes.length > 20 || !rawTypes.every(isOntologyType))
    return { ok: false, error: 'invalidTypes' };
  const types = [...new Set(rawTypes as OntologyTypeKey[])];

  // Status filters only make sense for one type (each type has its own statuses).
  let statuses: string[] | null = null;
  if (b.statuses !== undefined && b.statuses !== null) {
    const allowed = types.length === 1 ? (ONTOLOGY[types[0]].status?.values ?? []) : [];
    if (
      !Array.isArray(b.statuses) ||
      b.statuses.length === 0 ||
      b.statuses.length > 20 ||
      !b.statuses.every((s) => typeof s === 'string' && allowed.includes(s))
    ) {
      return { ok: false, error: 'invalidStatus' };
    }
    statuses = [...new Set(b.statuses as string[])];
  }

  const dateFrom =
    b.dateFrom === undefined || b.dateFrom === null || b.dateFrom === '' ? null : b.dateFrom;
  const dateTo = b.dateTo === undefined || b.dateTo === null || b.dateTo === '' ? null : b.dateTo;
  if ((dateFrom !== null && !validDate(dateFrom)) || (dateTo !== null && !validDate(dateTo)))
    return { ok: false, error: 'invalidDate' };
  if (dateFrom && dateTo && dateFrom > dateTo) return { ok: false, error: 'invalidDate' };

  const offset = b.offset === undefined ? 0 : Number(b.offset);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > SEARCH_LIMITS.maxOffset ||
    (offset > 0 && types.length !== 1)
  ) {
    return { ok: false, error: 'invalidOffset' };
  }

  const browsing =
    types.length === 1 && (statuses !== null || dateFrom !== null || dateTo !== null);
  if (q.length < (types.length === 1 ? 2 : SEARCH_LIMITS.minMultiTypeLength) && !browsing)
    return { ok: false, error: 'queryTooShort' };

  return {
    ok: true,
    request: {
      q,
      types,
      statuses,
      dateFrom: dateFrom as string | null,
      dateTo: dateTo as string | null,
      offset,
    },
  };
}
