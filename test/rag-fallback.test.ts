import {expect} from 'chai';
import {selectDirectRagAnswer} from '../src/rag-fallback';

describe('Direct RAG fallback', () => {
  it('answers a globally unique exact alias', () => {
    expect(selectDirectRagAnswer(
      [{
        text: 'Дополнительные устройства доступны.',
        denseScore: 0.40,
        denseRank: 8,
        lexicalRank: 1,
        exactAlias: true,
        lexicalEvidence: true,
        fusedScore: 0.7,
      }],
      {minimumMargin: 0.05},
    )).to.equal('Дополнительные устройства доступны.');
  });

  it('answers only a shared top-3 result with enough separation', () => {
    expect(selectDirectRagAnswer(
      [
        {
          text: 'Первый.', denseScore: 0.6, denseRank: 1, lexicalRank: 1,
          lexicalEvidence: true, fusedScore: 1,
        },
        {
          text: 'Второй.', denseScore: 0.58, denseRank: 2, lexicalRank: 5,
          lexicalEvidence: true, fusedScore: 0.8,
        },
      ],
      {minimumMargin: 0.05},
    )).to.equal('Первый.');
  });

  it('rejects ambiguity and missing lexical evidence', () => {
    expect(selectDirectRagAnswer(
      [
        {
          text: 'Первый.', denseScore: 0.6, denseRank: 1, lexicalRank: 1,
          lexicalEvidence: false, fusedScore: 1,
        },
        {
          text: 'Второй.', denseScore: 0.59, denseRank: 2, lexicalRank: 2,
          lexicalEvidence: true, fusedScore: 0.98,
        },
      ],
      {minimumMargin: 0.05},
    )).to.equal(null);
  });
});
