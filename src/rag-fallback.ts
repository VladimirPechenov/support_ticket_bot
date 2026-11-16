export interface RagFallbackDocument {
  text: string;
  score?: number;
  denseScore?: number;
  lexicalScore?: number;
  hybridScore?: number;
  fusedScore?: number;
  denseRank?: number;
  lexicalRank?: number;
  exactAlias?: boolean;
  lexicalEvidence?: boolean;
}

export interface DirectRagAnswerPolicy {
  minimumMargin?: number;
}

export function selectDirectRagAnswer(
  documents: RagFallbackDocument[],
  policy: DirectRagAnswerPolicy = {},
): string | null {
  const best = documents[0];
  if (!best?.text?.trim()) return null;

  if (best.exactAlias) return best.text.trim();

  const bestFused = best.fusedScore ?? best.hybridScore ?? best.score ?? 0;
  const secondFused = documents[1] ?
    documents[1].fusedScore ?? documents[1].hybridScore ??
      documents[1].score ?? 0 : 0;
  const margin = documents[1] ? bestFused - secondFused : 1;
  const safe =
    best.lexicalEvidence === true &&
    (best.denseRank || Number.MAX_SAFE_INTEGER) <= 3 &&
    (best.lexicalRank || Number.MAX_SAFE_INTEGER) <= 3 &&
    (best.denseScore || 0) >= 0.45 &&
    margin >= (policy.minimumMargin ?? 0.05);

  return safe ? best.text.trim() : null;
}
