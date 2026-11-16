import {expect} from 'chai';
import {
  diceSimilarity,
  normalizeRagText,
  ragTerms,
  rankRagDocuments,
  trigramSimilarity,
} from '../src/rag-ranking';

describe('BM25 + trigram + RRF ranking', () => {
  it('normalizes Russian text and tolerates small typos', () => {
    expect(normalizeRagText('  Ещё — Устройство! '))
      .to.equal('еще устройство');
    expect(diceSimilarity('Как докупить слот?', 'как докупить слот'))
      .to.equal(1);
    expect(trigramSimilarity('прамокод', 'промокод')).to.be.greaterThan(0.5);
    expect(ragTerms('персональная ссылка')).to.include('ссылк');
    expect(ragTerms('персональную ссылку')).to.include('ссылк');
  });

  it('uses aliases only in lexical rank and fuses independent ranks', () => {
    const ranked = rankRagDocuments(
      'Как докупить слот?',
      [
        {
          id: 'connection.install',
          title: 'Как установить сервис',
          text: 'Инструкция.',
          denseScore: 0.70,
        },
        {
          id: 'subscription.extra_devices',
          title: 'Дополнительные устройства',
          aliases: ['Как докупить слот?'],
          text: 'Можно приобрести дополнительное устройство.',
          denseScore: 0.46,
        },
      ],
      {denseContextThreshold: 0.52, maxDocuments: 3},
    );
    const article = ranked.find(
      document => document.id === 'subscription.extra_devices',
    );
    expect(article).not.to.equal(undefined);
    expect(article?.exactAlias).to.equal(true);
    expect(article?.lexicalRank).to.equal(1);
    expect(article?.denseRank).to.equal(2);
  });

  it('does not accept a weak dense result without lexical evidence', () => {
    const ranked = rankRagDocuments(
      'интеграция с календарём',
      [{title: 'Оплата', text: 'Оплата в боте.', denseScore: 0.44}],
      {denseContextThreshold: 0.52},
    );
    expect(ranked).to.have.length(0);
  });

  it('does not confuse a server refresh with a subscription refresh', () => {
    const results = rankRagDocuments(
      'Иногда не работают серверы, хотя я их обновляю',
      [
        {
          id: 'subscription.update_delay',
          title: 'Задержка обновления подписки',
          text: 'Обновление подписки может примениться с задержкой.',
          denseScore: 0.95,
        },
        {
          id: 'troubleshooting.all_servers',
          title: 'Не работает ни один сервер',
          text: 'Обновите подписку и перезапустите клиент.',
          denseScore: 0.8,
        },
      ],
      {denseContextThreshold: 0.5, maxDocuments: 3},
    );

    expect(results[0]?.id).to.equal('troubleshooting.all_servers');
    expect(results.map(result => result.id))
      .not.to.include('subscription.update_delay');
  });

  it('does not assume Windows or failed servers for a generic complaint', () => {
    const results = rankRagDocuments(
      'Я заплатила за сервис, а он не работает',
      [
        {
          id: 'troubleshooting.windows',
          title: 'сервис не работает на Windows',
          text: 'Проверьте клиент на Windows.',
          denseScore: 0.95,
        },
        {
          id: 'troubleshooting.all_servers',
          title: 'Не работает ни один сервер',
          text: 'Проверьте список серверов.',
          denseScore: 0.9,
        },
        {
          id: 'troubleshooting.general',
          title: 'Если ничего не работает',
          text: 'Уточните устройство, приложение, сеть и симптом.',
          denseScore: 0.8,
        },
      ],
      {denseContextThreshold: 0.5, maxDocuments: 3},
    );

    expect(results.map(result => result.id))
      .to.deep.equal(['troubleshooting.general']);
  });

  it('keeps a device-specific guide when the device is explicit', () => {
    const results = rankRagDocuments(
      'сервис не работает на Windows',
      [{
        id: 'troubleshooting.windows',
        title: 'сервис не работает на Windows',
        text: 'Проверьте клиент на Windows.',
        denseScore: 0.8,
      }],
      {denseContextThreshold: 0.5},
    );

    expect(results[0]?.id).to.equal('troubleshooting.windows');
  });
});
