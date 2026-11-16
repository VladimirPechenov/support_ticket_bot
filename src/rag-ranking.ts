export interface RagRankingDocument {
  id?: string;
  intent?: string;
  text: string;
  title?: string;
  source?: string;
  aliases?: string[];
  tags?: string[];
  score?: number;
  denseScore?: number;
}

export interface RankedRagDocument extends RagRankingDocument {
  score: number;
  denseScore: number;
  lexicalScore: number;
  hybridScore: number;
  fusedScore: number;
  denseRank: number;
  lexicalRank: number;
  exactAlias: boolean;
  lexicalEvidence: boolean;
  queryCoverage: number;
}

export interface RagRankingOptions {
  rrfK?: number;
  denseWeight?: number;
  denseContextThreshold?: number;
  minimumQueryCoverage?: number;
  maxDocuments?: number;
}

const STOP_WORDS = new Set([
  'а', 'без', 'бы', 'в', 'во', 'где', 'для', 'до', 'и', 'из', 'или', 'как',
  'к', 'ли', 'мне', 'мой', 'моя', 'на', 'не', 'но', 'о', 'по', 'под', 'при',
  'с', 'со', 'у', 'что', 'это', 'я', 'вы', 'ваш', 'ваша', 'есть', 'если',
  'можно', 'нужно', 'хочу', 'делать', 'demodesk',
]);

const RUSSIAN_SUFFIXES = [
  'иями', 'ями', 'ами', 'его', 'ого', 'ему', 'ому', 'иях', 'ах', 'ях',
  'ировать', 'ироватьcя', 'овать', 'ывать', 'иться', 'ется', 'ются',
  'ение', 'ения', 'ений', 'енный', 'анная', 'ить', 'ать', 'ять',
  'ами', 'ями', 'ов', 'ев', 'ей', 'ый', 'ий', 'ая', 'ое', 'ые', 'ого',
  'ому', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'у', 'ю', 'а', 'я', 'ы', 'и',
];

export function normalizeRagText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stem(token: string): string {
  if (token.length < 5 || !/[а-я]/.test(token)) return token;
  for (const suffix of RUSSIAN_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function tokenize(value: string): string[] {
  const normalized = normalizeRagText(value);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .filter(token => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem);
}

export function ragTerms(value: string): Set<string> {
  return new Set(tokenize(value));
}

export function diceSimilarity(left: string, right: string): number {
  const leftTokens = ragTerms(left);
  const rightTokens = ragTerms(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection++;
  }
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function trigrams(value: string): Set<string> {
  const normalized = ` ${normalizeRagText(value)} `;
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 2; index++) {
    result.add(normalized.slice(index, index + 3));
  }
  return result;
}

export function trigramSimilarity(left: string, right: string): number {
  const leftGrams = trigrams(left);
  const rightGrams = trigrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let intersection = 0;
  for (const trigram of leftGrams) {
    if (rightGrams.has(trigram)) intersection++;
  }
  return (2 * intersection) / (leftGrams.size + rightGrams.size);
}

function searchableText(document: RagRankingDocument): string {
  return [
    document.title || '',
    document.intent || '',
    ...(document.aliases || []),
    ...(document.tags || []),
    document.text || '',
  ].join(' ');
}

const EXPLICIT_TOPIC_REQUIREMENTS: Record<string, RegExp> = {
  'troubleshooting.windows':
    /(?:windows|виндовс|винд[а-я]*|(?:^|\s)пк(?:\s|$)|компьютер[а-я]*|ноутбук[а-я]*)/u,
  'app.windows_install':
    /(?:windows|виндовс|винд[а-я]*|(?:^|\s)пк(?:\s|$)|компьютер[а-я]*|ноутбук[а-я]*)/u,
  'app.ios_install':
    /(?:^|\s)(?:ios|iphone|ipad|айфон|айпад)(?:\s|$)/u,
  'app.ios_unavailable':
    /(?:^|\s)(?:ios|iphone|ipad|айфон|айпад)(?:\s|$)/u,
  'app.android': /(?:^|\s)(?:android|андроид)(?:\s|$)/u,
  'app.android_unstable':
    /(?:^|\s)(?:android|андроид)(?:\s|$)/u,
  'app.linux':
    /(?:^|\s)(?:linux|линукс|ubuntu|убунту)(?:\s|$)/u,
  'app.macos_install':
    /(?:^|\s)(?:macos|macbook|макбук|мак|mac)(?:\s|$)/u,
  'app.android_tv':
    /(?:^|\s)(?:android tv|google tv|яндекс tv|яндекс тв|телевизор|приставка)(?:\s|$)/u,
  'troubleshooting.all_servers':
    /(?:сервер[а-я]*|локаци[а-я]*)/u,
};

function isCompatibleWithExplicitTopic(
  query: string,
  document: RagRankingDocument,
): boolean {
  const normalized = normalizeRagText(query);
  const requirement = document.id ? EXPLICIT_TOPIC_REQUIREMENTS[document.id] :
    undefined;
  if (requirement && !requirement.test(normalized)) return false;
  if (document.id === 'subscription.update_delay') {
    return /подпис|конфиг|конфигурац|оплат|продл/u.test(normalized);
  }
  return true;
}

interface LexicalValues {
  rawScore: number;
  trigramScore: number;
  coverage: number;
  exactAlias: boolean;
  lexicalEvidence: boolean;
}

function calculateBm25(
  query: string,
  documents: RagRankingDocument[],
): LexicalValues[] {
  const queryTokens = Array.from(ragTerms(query));
  const tokenizedDocuments = documents.map(document =>
    tokenize(searchableText(document)),
  );
  const averageLength = tokenizedDocuments.reduce(
    (sum, documentTokens) => sum + documentTokens.length,
    0,
  ) / Math.max(1, tokenizedDocuments.length);
  const documentFrequency = new Map<string, number>();
  for (const queryToken of queryTokens) {
    documentFrequency.set(
      queryToken,
      tokenizedDocuments.filter(tokens => tokens.includes(queryToken)).length,
    );
  }
  const k1 = 1.2;
  const b = 0.75;
  return documents.map((document, documentIndex) => {
    const documentTokens = tokenizedDocuments[documentIndex];
    const frequencies = new Map<string, number>();
    for (const token of documentTokens) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
    let rawScore = 0;
    let matchedTokens = 0;
    for (const queryToken of queryTokens) {
      const frequency = frequencies.get(queryToken) || 0;
      if (!frequency) continue;
      matchedTokens++;
      const frequencyInCorpus = documentFrequency.get(queryToken) || 0;
      const idf = Math.log(
        1 + (documents.length - frequencyInCorpus + 0.5) /
          (frequencyInCorpus + 0.5),
      );
      const denominator = frequency + k1 * (
        1 - b + b * documentTokens.length / Math.max(1, averageLength)
      );
      rawScore += idf * (frequency * (k1 + 1)) / denominator;
    }
    const variants = [document.title || '', ...(document.aliases || [])];
    const trigramScore = variants.reduce(
      (best, variant) => Math.max(best, trigramSimilarity(query, variant)),
      0,
    );
    rawScore += trigramScore * 0.35;
    const coverage = queryTokens.length > 0 ?
      matchedTokens / queryTokens.length : 0;
    const normalizedQuery = normalizeRagText(query);
    const exactAlias = (document.aliases || []).some(
      alias => normalizeRagText(alias) === normalizedQuery,
    );
    const lexicalEvidence = exactAlias ||
      (rawScore >= 1.5 && coverage >= 0.5) || trigramScore >= 0.58;
    return {rawScore, trigramScore, coverage, exactAlias, lexicalEvidence};
  });
}

export function rankRagDocuments(
  query: string,
  documents: RagRankingDocument[],
  options: RagRankingOptions = {},
): RankedRagDocument[] {
  if (documents.length === 0) return [];
  const denseWeight = Math.min(1, Math.max(0, options.denseWeight ?? 0.5));
  const lexicalWeight = 1 - denseWeight;
  const denseThreshold = options.denseContextThreshold ?? 0.52;
  const minimumQueryCoverage = Math.min(
    1,
    Math.max(0, options.minimumQueryCoverage ?? 0),
  );
  const maxDocuments = options.maxDocuments ?? documents.length;
  const lexicalValues = calculateBm25(query, documents);
  const denseOrder = documents
    .map((document, index) => ({
      index,
      score: document.denseScore ?? document.score ?? 0,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const lexicalOrder = lexicalValues
    .map((value, index) => ({index, score: value.rawScore}))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const denseRanks = new Map(
    denseOrder.map((entry, index) => [entry.index, index + 1]),
  );
  const lexicalRanks = new Map(
    lexicalOrder.map((entry, index) => [entry.index, index + 1]),
  );
  const ranked = documents
    .map((document, index): RankedRagDocument => {
      const denseScore = document.denseScore ?? document.score ?? 0;
      const denseRank = denseRanks.get(index) || documents.length;
      const lexicalRank = lexicalRanks.get(index) || documents.length;
      const lexical = lexicalValues[index];
      // Keep confidence on an absolute, cross-query scale. The previous
      // per-result min/max normalization made every top result equal to 1,
      // including unrelated questions, so no confidence threshold could work.
      const bm25Confidence = 1 - Math.exp(-lexical.rawScore / 3);
      const lexicalScore = Math.min(1,
        lexical.coverage * 0.5 +
        lexical.trigramScore * 0.3 +
        bm25Confidence * 0.2 +
        (lexical.exactAlias ? 0.35 : 0),
      );
      const fusedScore = Math.min(1,
        denseWeight * Math.max(0, Math.min(1, denseScore)) +
        lexicalWeight * lexicalScore +
        (lexical.exactAlias ? 0.08 : 0),
      );
      return {
        ...document,
        denseScore,
        denseRank,
        lexicalRank,
        lexicalScore,
        exactAlias: lexical.exactAlias,
        lexicalEvidence: lexical.lexicalEvidence,
        queryCoverage: lexical.coverage,
        fusedScore,
        hybridScore: fusedScore,
        score: fusedScore,
      };
    });
  return ranked
    .filter(document =>
      !!document.text &&
      isCompatibleWithExplicitTopic(query, document) &&
      (
        document.denseScore >= denseThreshold ||
        (
          document.lexicalEvidence &&
          document.queryCoverage >= minimumQueryCoverage
        )
      ),
    )
    .sort((left, right) =>
      right.fusedScore - left.fusedScore ||
      right.denseScore - left.denseScore,
    )
    .slice(0, maxDocuments);
}
