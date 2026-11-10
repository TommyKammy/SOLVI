export const KNOWLEDGE_PAGE_SIZE = 20;
export const KNOWLEDGE_SEARCH_MAX_LENGTH = 200;
export const KNOWLEDGE_CURSOR_MAX_LENGTH = 168;

type QueryInput = Record<string, string | string[] | undefined>;
export type KnowledgeQuery = {
  q: string;
  manage: boolean;
  cursor?: string;
  error: 'cursor' | null;
};
export type HighlightPart = { text: string; match: boolean };
const first = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : (value?.[0] ?? '');

/** q/manage retain the API's first-value behavior; cursors are opaque and never decoded here. */
export function parseKnowledgeQuery(raw: QueryInput, staff: boolean): KnowledgeQuery {
  // Match the API's UTF-16 cap, then use the URL/UTF-8 replacement for an unpaired surrogate.
  // This keeps the displayed value and the query forwarded on subsequent links identical.
  const q =
    new URLSearchParams({ q: first(raw.q).trim().slice(0, KNOWLEDGE_SEARCH_MAX_LENGTH) }).get(
      'q',
    ) ?? '';
  const cursor = first(raw.cursor);
  return {
    q,
    manage: first(raw.manage) === '1' && staff,
    ...(cursor ? { cursor } : {}),
    error:
      Array.isArray(raw.cursor) ||
      (raw.cursor !== undefined &&
        (!cursor ||
          cursor.length > KNOWLEDGE_CURSOR_MAX_LENGTH ||
          !/^[A-Za-z0-9_-]+$/.test(cursor)))
        ? 'cursor'
        : null,
  };
}

/** Only presentation keys belong in the browser URL; the API page size stays fixed at 20. */
export function knowledgeHref(query: Pick<KnowledgeQuery, 'q' | 'manage' | 'cursor'>): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.manage) params.set('manage', '1');
  if (query.cursor) params.set('cursor', query.cursor);
  return `/knowledge${params.size ? `?${params}` : ''}`;
}

/** Text decoration only: PostgreSQL remains authoritative for inclusion and order. */
export function knowledgeHighlights(text: string, query: string): HighlightPart[] {
  const keyword = query.trim().slice(0, KNOWLEDGE_SEARCH_MAX_LENGTH);
  if (!keyword) return [{ text, match: false }];
  const expression = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const parts: HighlightPart[] = [];
  let end = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index > end) parts.push({ text: text.slice(end, match.index), match: false });
    parts.push({ text: match[0], match: true });
    end = match.index + match[0].length;
  }
  if (end < text.length || parts.length === 0) parts.push({ text: text.slice(end), match: false });
  return parts;
}

export function knowledgeExcerpt(body: string, query: string) {
  const parts = knowledgeHighlights(body, query);
  const firstMatch = parts.findIndex((part) => part.match);
  const characters = Array.from(body);
  const matchStart =
    firstMatch < 0
      ? 0
      : Array.from(
          parts
            .slice(0, firstMatch)
            .map((part) => part.text)
            .join(''),
        ).length;
  const matchedLength = firstMatch < 0 ? 0 : Array.from(parts[firstMatch]?.text ?? '').length;
  const size = query.trim() ? 220 : 140;
  const before = Math.min(60, Math.max(0, Math.floor((size - matchedLength) / 2)));
  const start = characters.length <= size ? 0 : Math.max(0, matchStart - before);
  const end = Math.min(characters.length, start + size);
  return {
    parts: knowledgeHighlights(characters.slice(start, end).join(''), query),
    leading: start > 0,
    trailing: end < characters.length,
    matched: firstMatch >= 0,
  };
}
