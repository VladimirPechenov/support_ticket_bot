import {expect} from 'chai';
const {buildEmbeddingText, loadDocuments, normalize, validateDocuments} = require('../setup_qdrant');

describe('synthetic knowledge schema', () => {
  it('validates the schema of all six demonstration records', () => {
    const documents = loadDocuments();
    expect(documents).to.have.length(6);
    for (const doc of documents) {
      expect(doc).to.include.all.keys('id', 'title', 'answer', 'aliases', 'tags', 'source', 'updated_at');
      expect(doc.source).to.equal('synthetic_test_fixture');
      expect(doc.aliases).to.be.an('array');
      expect(doc.tags).to.be.an('array');
    }
    expect(() => validateDocuments(documents)).not.to.throw();
  });
  it('keeps document IDs and normalized aliases unique', () => {
    const docs = loadDocuments();
    const ids = docs.map((doc: any) => doc.id);
    const aliases = docs.flatMap((doc: any) => doc.aliases.map(normalize));
    expect(new Set(ids).size).to.equal(ids.length);
    expect(new Set(aliases).size).to.equal(aliases.length);
  });
  it('embeds intent, aliases and the canonical answer', () => {
    const doc = {title: 'Вход', intent: 'Доступ к аккаунту',
      answer: 'Откройте страницу входа.', aliases: ['Как войти?'], tags: ['account']};
    const text = buildEmbeddingText(doc);
    for (const part of [doc.title, doc.intent, doc.answer, doc.aliases[0]])
      expect(text).to.include(part);
  });
  it('rejects malformed records instead of silently indexing them', () => {
    expect(() => validateDocuments([{id: 'broken'}])).to.throw();
  });
});
