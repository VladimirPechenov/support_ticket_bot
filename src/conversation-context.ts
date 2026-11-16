import {AiMessage} from './interfaces';
import {normalizeRagText} from './rag-ranking';

const FOLLOW_UP_PATTERNS = [
  /^(?:а|и|но)(?:\s|$)/u,
  /(?:^|\s)(?:это|этот|эта|эти|там|туда|оттуда|так|такой|такая|его|ее|их)(?:\s|$)/u,
  /(?:^|\s)(?:дальше|теперь|снова|опять|тогда|после этого)(?:\s|$)/u,
  /^(?:где|куда|как|почему|сколько|когда)\s+(?:это|его|ее|там|тогда)(?:\s|$)/u,
  /^(?:не помогло|не получилось|не работает|не подключается|не вижу|не могу|что дальше)(?:\s|$)/u,
  /^что\s+(?:(?:мне\s+)?нужно\s+)?(?:сделать|делать)(?:\s|$)/u,
];

export function isContextDependentQuestion(value: string): boolean {
  const normalized = normalizeRagText(value);
  if (!normalized) return false;
  return FOLLOW_UP_PATTERNS.some(pattern =>
    pattern.test(normalized),
  );
}

function isClarificationAnswer(
  userText: string,
  history: AiMessage[],
): boolean {
  const current = normalizeRagText(userText);
  if (!current || current.split(' ').length > 4 ||
    /^(?:как|где|куда|почему|сколько|когда|зачем|что|кто)(?:\s|$)/u.test(current)) {
    return false;
  }
  const previous = history[history.length - 1];
  return previous?.role === 'assistant' &&
    /\?|(?:уточните|подскажите|выберите)/iu.test(previous.content);
}

export function selectRelevantHistory(
  userText: string,
  history: AiMessage[] = [],
): AiMessage[] {
  if (!isContextDependentQuestion(userText) &&
    !isClarificationAnswer(userText, history)) return [];
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role === 'user' && history[index].content.trim()) {
      return history.slice(index).filter(message => message.content.trim());
    }
  }
  return [];
}

export function buildRetrievalQuery(
  userText: string,
  history: AiMessage[] = [],
  maximumPreviousUserMessages = 2,
): string {
  const current = String(userText || '').trim();
  if (!current) return current;
  if (maximumPreviousUserMessages <= 0) return current;
  const relevantHistory = selectRelevantHistory(current, history).filter(
    message => normalizeRagText(message.content) !== normalizeRagText(current),
  );
  if (relevantHistory.length === 0) return current;
  if (!isContextDependentQuestion(current)) {
    // Search for the user's selected option, not every option in the
    // assistant's clarification question. Keep the full exchange for the LLM.
    return [...relevantHistory.filter(message => message.role === 'user')
      .map(message => message.content.trim()), current].join('\n');
  }
  const recentExchange = relevantHistory.map(message => message.content.trim());
  // Retrieval indexes the text itself. Labels such as "Текущий вопрос"
  // introduce unrelated terms and dilute coverage in lexical-only mode.
  return [...recentExchange, current].join('\n');
}
