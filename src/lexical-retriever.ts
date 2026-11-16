import * as fs from 'fs';
import * as path from 'path';
import type {VerifiedDocsStore} from './verified-docs';

export type LexicalDocumentKind = 'knowledge_base' | 'verified_document';

export interface LexicalDocument {
  id: string;
  title: string;
  text: string;
  aliases?: string[];
  tags?: string[];
  source: string;
  kind: LexicalDocumentKind;
  url?: string;
  updatedAt?: string;
}

export interface LexicalSearchOptions {
  limit?: number;
  minimumScore?: number;
  snippetLength?: number;
  kinds?: LexicalDocumentKind[];
}

export interface LexicalSearchResult extends LexicalDocument {
  score: number;
  coverage: number;
  exactMatch: boolean;
  snippet: string;
}

export interface CachedVerifiedDocumentLike {
  sourceId: string;
  title: string;
  url: string;
  text: string;
  fetchedAt?: string;
}

interface IndexedDocument {
  document: LexicalDocument;
  tokens: string[];
  frequencies: Map<string, number>;
  titleTokens: Set<string>;
  aliasTokens: Set<string>;
  normalizedTitle: string;
  normalizedAliases: string[];
}

const STOP_WORDS = new Set([
  'а', 'без', 'бы', 'в', 'во', 'где', 'для', 'до', 'и', 'из', 'или', 'как',
  'к', 'ли', 'мне', 'мой', 'моя', 'на', 'не', 'но', 'о', 'по', 'под', 'при',
  'с', 'со', 'у', 'что', 'это', 'я', 'вы', 'ваш', 'ваша', 'есть', 'если',
  'можно', 'нужно', 'хочу', 'делать', 'пожалуйста', 'здравствуйте', 'demodesk',
]);

const RUSSIAN_SUFFIXES = [
  'ироваться', 'ировать', 'ениями', 'овать', 'ывать', 'иться',
  'иями', 'ение', 'ения', 'ений', 'енный', 'анная', 'ями', 'ами',
  'ется', 'ются', 'его', 'ого', 'ему', 'ому', 'иях', 'ить', 'ать', 'ять',
  'ов', 'ев', 'ей', 'ый', 'ий', 'ая', 'ое', 'ые', 'ам', 'ям', 'ах', 'ях',
  'ом', 'ем', 'у', 'ю', 'а', 'я', 'ы', 'и',
];

export function normalizeLexicalText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(/[^a-z\u0430-\u044f0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stemToken(token: string): string {
  if (token.length < 5 || !/[\u0430-\u044f]/.test(token)) return token;
  for (const suffix of RUSSIAN_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenizeLexicalText(value: string): string[] {
  const normalized = normalizeLexicalText(value);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .filter(token => token.length > 1 && !STOP_WORDS.has(token))
    .map(stemToken);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isSingleEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length <= right.length) j++;
    if (left.length >= right.length) i++;
  }
  return edits + (left.length - i) + (right.length - j) === 1;
}

function countTokens(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }
  return frequencies;
}

function cleanSnippetText(text: string): string {
  const withoutControls = Array.from(String(text || ''), character => {
    const code = character.charCodeAt(0);
    return (code <= 8 || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || code === 127) ? ' ' : character;
  }).join('');
  return withoutControls
    .replace(/\s+/g, ' ')
    .trim();
}

function createSnippet(text: string, query: string, maximumLength: number): string {
  const clean = cleanSnippetText(text);
  if (clean.length <= maximumLength) return clean;
  const queryWords = normalizeLexicalText(query)
    .split(' ')
    .filter(word => word.length > 2);
  const lower = clean.toLowerCase().replace(/\u0451/g, '\u0435');
  let matchIndex = -1;
  for (const word of queryWords) {
    const candidate = lower.indexOf(word);
    if (candidate >= 0 && (matchIndex < 0 || candidate < matchIndex)) {
      matchIndex = candidate;
    }
  }
  const half = Math.floor(maximumLength / 2);
  const start = Math.max(0, Math.min(
    matchIndex < 0 ? 0 : matchIndex - half,
    clean.length - maximumLength,
  ));
  const prefix = start > 0 ? '\u2026' : '';
  const suffix = start + maximumLength < clean.length ? '\u2026' : '';
  return `${prefix}${clean.slice(start, start + maximumLength).trim()}${suffix}`;
}

function validateDocument(document: LexicalDocument): LexicalDocument {
  if (!document || !String(document.id || '').trim()) {
    throw new Error('Lexical document id is required');
  }
  if (!String(document.title || '').trim()) {
    throw new Error(`Lexical document ${document.id} has no title`);
  }
  if (!String(document.text || '').trim()) {
    throw new Error(`Lexical document ${document.id} has no text`);
  }
  return {
    ...document,
    id: String(document.id).trim(),
    title: String(document.title).trim(),
    text: String(document.text).trim(),
    aliases: (document.aliases || []).map(String).filter(Boolean),
    tags: (document.tags || []).map(String).filter(Boolean),
    source: String(document.source || 'unknown'),
  };
}

export class LexicalRetriever {
  private readonly documents: IndexedDocument[];
  private readonly averageLength: number;
  private readonly documentFrequency: Map<string, number>;

  constructor(documents: LexicalDocument[]) {
    const ids = new Set<string>();
    this.documents = documents.map(input => {
      const document = validateDocument(input);
      if (ids.has(document.id)) {
        throw new Error(`Duplicate lexical document id: ${document.id}`);
      }
      ids.add(document.id);
      const titleTokens = new Set(tokenizeLexicalText(document.title));
      const aliasTokens = new Set(tokenizeLexicalText(
        (document.aliases || []).join(' '),
      ));
      const tokens = tokenizeLexicalText([
        document.title,
        ...(document.aliases || []),
        ...(document.tags || []),
        document.text,
      ].join(' '));
      return {
        document,
        tokens,
        frequencies: countTokens(tokens),
        titleTokens,
        aliasTokens,
        normalizedTitle: normalizeLexicalText(document.title),
        normalizedAliases: (document.aliases || []).map(normalizeLexicalText),
      };
    });
    this.averageLength = this.documents.reduce(
      (sum, document) => sum + document.tokens.length,
      0,
    ) / Math.max(1, this.documents.length);
    this.documentFrequency = new Map<string, number>();
    const vocabulary = new Set<string>();
    for (const document of this.documents) {
      for (const token of unique(document.tokens)) vocabulary.add(token);
    }
    for (const token of vocabulary) {
      this.documentFrequency.set(token, this.documents.reduce(
        (count, document) => count + (document.frequencies.has(token) ? 1 : 0),
        0,
      ));
    }
  }

  get size(): number {
    return this.documents.length;
  }

  search(query: string, options: LexicalSearchOptions = {}): LexicalSearchResult[] {
    const normalizedQuery = normalizeLexicalText(query);
    const queryTokens = unique(tokenizeLexicalText(query).map(token => {
      if (token.length < 4 || this.documentFrequency.has(token)) return token;
      // Correct only unknown words with one unambiguous edit in the corpus.
      // Never upgrade a correction into an exact alias match.
      const candidates = Array.from(this.documentFrequency.keys())
        .filter(candidate => isSingleEdit(token, candidate));
      return candidates.length === 1 ? candidates[0] : token;
    }));
    if (!normalizedQuery || queryTokens.length === 0) return [];
    const limit = Math.max(1, Math.min(20, options.limit ?? 3));
    const minimumScore = Math.max(0, options.minimumScore ?? 0.05);
    const snippetLength = Math.max(100, Math.min(
      4096,
      options.snippetLength ?? 1200,
    ));
    const allowedKinds = options.kinds ? new Set(options.kinds) : undefined;
    const k1 = 1.2;
    const b = 0.75;

    return this.documents
      .filter(indexed => !allowedKinds || allowedKinds.has(indexed.document.kind))
      .map((indexed, originalIndex): LexicalSearchResult | undefined => {
        let bm25 = 0;
        let matched = 0;
        for (const token of queryTokens) {
          const frequency = indexed.frequencies.get(token) || 0;
          if (!frequency) continue;
          matched++;
          const df = this.documentFrequency.get(token) || 0;
          const idf = Math.log(
            1 + (this.documents.length - df + 0.5) / (df + 0.5),
          );
          const denominator = frequency + k1 * (
            1 - b + b * indexed.tokens.length / Math.max(1, this.averageLength)
          );
          bm25 += idf * (frequency * (k1 + 1)) / denominator;
          if (indexed.titleTokens.has(token)) bm25 += idf * 0.8;
          if (indexed.aliasTokens.has(token)) bm25 += idf * 1.1;
        }
        const coverage = matched / queryTokens.length;
        const exactMatch = indexed.normalizedTitle === normalizedQuery ||
          indexed.normalizedAliases.includes(normalizedQuery);
        const phraseMatch = normalizeLexicalText([
          indexed.document.title,
          ...(indexed.document.aliases || []),
        ].join(' ')).includes(normalizedQuery);
        const score = bm25 + coverage * 0.35 +
          (phraseMatch ? 1.25 : 0) + (exactMatch ? 3 : 0);
        if (!matched || score < minimumScore) return undefined;
        return {
          ...indexed.document,
          score,
          coverage,
          exactMatch,
          snippet: createSnippet(indexed.document.text, query, snippetLength),
          _originalIndex: originalIndex,
        } as LexicalSearchResult & {_originalIndex: number};
      })
      .filter((result): result is LexicalSearchResult & {_originalIndex: number} =>
        !!result,
      )
      .sort((left, right) =>
        right.score - left.score ||
        right.coverage - left.coverage ||
        left._originalIndex - right._originalIndex,
      )
      .slice(0, limit)
      .map(({_originalIndex: _ignored, ...result}) => result);
  }
}

interface KnowledgeBaseLine {
  id?: unknown;
  title?: unknown;
  answer?: unknown;
  aliases?: unknown;
  tags?: unknown;
  source?: unknown;
  updated_at?: unknown;
}

export function loadSupportKnowledgeBase(
  filePath: string = process.env.SUPPORT_KB_PATH || path.join(process.cwd(), 'config', 'knowledge-base.jsonl'),
): LexicalDocument[] {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let parsed: KnowledgeBaseLine;
      try {
        parsed = JSON.parse(line) as KnowledgeBaseLine;
      } catch (_error) {
        throw new Error(`Invalid knowledge base JSON at line ${index + 1}`);
      }
      if (
        typeof parsed.id !== 'string' ||
        typeof parsed.title !== 'string' ||
        typeof parsed.answer !== 'string' ||
        !Array.isArray(parsed.aliases) ||
        !Array.isArray(parsed.tags)
      ) {
        throw new Error(`Invalid knowledge base document at line ${index + 1}`);
      }
      return validateDocument({
        id: parsed.id,
        title: parsed.title,
        text: parsed.answer,
        aliases: parsed.aliases.map(String),
        tags: parsed.tags.map(String),
        source: typeof parsed.source === 'string' ? parsed.source : 'support_kb',
        kind: 'knowledge_base',
        updatedAt: typeof parsed.updated_at === 'string' ?
          parsed.updated_at : undefined,
      });
    });
}

export function verifiedDocumentsToLexical(
  documents: CachedVerifiedDocumentLike[],
): LexicalDocument[] {
  return documents.map(document => validateDocument({
    id: `verified:${document.sourceId}`,
    title: document.title,
    text: document.text,
    source: document.sourceId,
    kind: 'verified_document',
    url: document.url,
    updatedAt: document.fetchedAt,
  }));
}

export function createLocalLexicalRetriever(options: {
  knowledgeBasePath?: string;
} = {}): LexicalRetriever {
  return new LexicalRetriever(loadSupportKnowledgeBase(
    options.knowledgeBasePath,
  ));
}

export async function createLocalLexicalRetrieverFromStore(
  store: VerifiedDocsStore,
  options: {knowledgeBasePath?: string} = {},
): Promise<LexicalRetriever> {
  const snapshot = await store.load();
  return new LexicalRetriever([
    ...loadSupportKnowledgeBase(options.knowledgeBasePath),
    ...verifiedDocumentsToLexical(Object.values(snapshot.documents)),
  ]);
}
