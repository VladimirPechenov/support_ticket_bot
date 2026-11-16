import {expect} from 'chai';
import {
  createLocalLexicalRetriever, createLocalLexicalRetrieverFromStore,
  LexicalRetriever, loadSupportKnowledgeBase, normalizeLexicalText,
  verifiedDocumentsToLexical,
} from '../src/lexical-retriever';
import {InMemoryVerifiedDocsStore, VERIFIED_SOURCE_REGISTRY,
  VerifiedDocsSnapshot} from '../src/verified-docs';

describe('local lexical retriever with synthetic records', () => {
  it('finds an exact alias in the synthetic fixture', () => {
    const [result] = createLocalLexicalRetriever().search('Как восстановить пароль?');
    expect(result?.id).to.equal('account.password');
    expect(result?.exactMatch).to.equal(true);
  });
  it('does not guess between ambiguous spelling corrections', () => {
    const retriever = new LexicalRetriever(['маска', 'каска'].map(word => ({
      id: word, title: word, text: word, source: 'test',
      kind: 'knowledge_base' as const,
    })));
    expect(retriever.search('таска')).to.deep.equal([]);
  });
  it('loads only the six explicitly synthetic test documents', () => {
    const docs = loadSupportKnowledgeBase();
    expect(docs).to.have.length(6);
    expect(docs.every(doc => doc.kind === 'knowledge_base' &&
      doc.source === 'synthetic_test_fixture')).to.equal(true);
  });
  it('normalizes Russian text and ranks a relevant account question', () => {
    expect(normalizeLexicalText(' Ещё — Устройство! ')).to.equal('еще устройство');
    const [result] = createLocalLexicalRetriever().search('Как войти в аккаунт?');
    expect(result?.id).to.equal('account.login');
  });
  it('returns no result without lexical evidence', () => {
    expect(createLocalLexicalRetriever().search('quuxxy zorbtron')).to.deep.equal([]);
  });
  it('maps approved cached pages into the same search shape', () => {
    const docs = verifiedDocumentsToLexical([{
      sourceId: 'sample_privacy', title: 'Политика конфиденциальности',
      url: 'https://example.com/legal/privacy',
      text: 'Персональные данные обрабатываются только по правовому основанию.',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    }]);
    const [result] = new LexicalRetriever(docs).search('персональные данные');
    expect(result?.kind).to.equal('verified_document');
    expect(result?.url).to.equal('https://example.com/legal/privacy');
  });
  it('combines synthetic knowledge with a mocked approved-page snapshot', async () => {
    const source = VERIFIED_SOURCE_REGISTRY[0];
    const snapshot: VerifiedDocsSnapshot = {
      version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
      documents: {[source.sourceId]: {
        sourceId: source.sourceId, title: source.title, url: source.url,
        text: 'Диагностика сетевого подключения.',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      }},
    };
    const retriever = await createLocalLexicalRetrieverFromStore(
      new InMemoryVerifiedDocsStore(snapshot));
    expect(retriever.size).to.equal(7);
    expect(retriever.search('диагностика сетевого подключения')[0]?.kind)
      .to.equal('verified_document');
  });
  it('caps output snippets and result count', () => {
    const retriever = new LexicalRetriever(Array.from({length: 25}, (_, i) => ({
      id: `doc-${i}`, title: `Инструкция ${i}`,
      text: `Подробная инструкция ${'шаг '.repeat(100)}`, source: 'test',
      kind: 'knowledge_base' as const,
    })));
    const result = retriever.search('инструкция', {limit: 100, snippetLength: 100});
    expect(result).to.have.length(20);
    expect(result.every(doc => doc.snippet.length <= 102)).to.equal(true);
  });
});
