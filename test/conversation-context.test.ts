import {expect} from 'chai';
import {
  buildRetrievalQuery,
  isContextDependentQuestion,
  selectRelevantHistory,
} from '../src/conversation-context';

describe('conversation-aware retrieval query', () => {
  it('preserves an exact alias when a user repeats a question', () => {
    expect(buildRetrievalQuery('Не работает', [
      {role: 'user', content: 'Не работает!'},
    ])).to.equal('Не работает');
  });

  it('does not index context labels as part of the question', () => {
    expect(buildRetrievalQuery('Не работает', [
      {role: 'user', content: 'У меня iPhone'},
    ])).to.equal('У меня iPhone\nНе работает');
  });

  it('keeps the last clarification exchange for a one-word selected option', () => {
    const history = [
      {role: 'user' as const, content: 'Не работает'},
      {role: 'assistant' as const, content: 'Какое устройство используете?'},
      {role: 'user' as const, content: 'Подписка'},
      {role: 'assistant' as const, content:
        'Вы хотите продлить её, обновить конфигурацию или добавить устройства?'},
    ];
    expect(selectRelevantHistory('Продлить', history)).to.deep.equal(
      history.slice(2),
    );
    expect(buildRetrievalQuery('Продлить', history)).to.equal(
      'Подписка\nПродлить',
    );
  });

  it('keeps a new complete question separate after a clarification', () => {
    const history = [
      {role: 'user' as const, content: 'Как продлить?'},
      {role: 'assistant' as const, content: 'На какой срок хотите продлить?'},
    ];
    expect(selectRelevantHistory('Как подключить', history)).to.deep.equal([]);
    expect(buildRetrievalQuery('Как подключить', history)).to.equal(
      'Как подключить',
    );
    expect(selectRelevantHistory('Продлить', [
      {role: 'user', content: 'Подписка'},
      {role: 'assistant', content: 'Подписка активна.'},
    ])).to.deep.equal([]);
  });

  it('keeps a complete standalone question unchanged', () => {
    const question = 'Как купить дополнительное устройство для подписки?';
    expect(buildRetrievalQuery(question, [{
      role: 'user', content: 'Ранее спрашивал про Windows.',
    }])).to.equal(question);
  });

  it('resolves a short follow-up with recent user context', () => {
    const query = buildRetrievalQuery('А где это нажать?', [
      {role: 'user', content: 'Где найти персональную ссылку?'},
      {role: 'assistant', content: 'Она находится в главном меню.'},
    ]);
    expect(query).to.include('Где найти персональную ссылку?');
    expect(query).to.include('А где это нажать?');
    expect(query).not.to.include('Текущий вопрос:');
    expect(query).to.include('Она находится в главном меню.');
  });

  it('does not let a prior intent contaminate a short standalone question', () => {
    const query = buildRetrievalQuery('Как подключить', [
      {role: 'user', content: 'Как продлить'},
      {role: 'assistant', content: 'Оплатите период в боте.'},
    ]);

    expect(isContextDependentQuestion('Как подключить')).to.equal(false);
    expect(query).to.equal('Как подключить');
  });

  it('does not send an old topic to the model for a standalone complaint', () => {
    const history = [
      {role: 'user' as const, content: 'У меня иногда не работают серверы'},
      {role: 'assistant' as const, content: 'Обновите список серверов.'},
    ];
    expect(selectRelevantHistory(
      'Я заплатила за сервис, а он не работает',
      history,
    )).to.deep.equal([]);
  });

  it('sends only the immediately preceding exchange for a follow-up', () => {
    const history = [
      {role: 'user' as const, content: 'Как оплатить подписку?'},
      {role: 'assistant' as const, content: 'Выберите период в боте.'},
      {role: 'user' as const, content: 'У меня iPhone и ExampleClient'},
      {role: 'assistant' as const, content: 'Что именно не работает?'},
    ];
    expect(selectRelevantHistory('Не подключается', history)).to.deep.equal(
      history.slice(2),
    );
  });

  it('uses only the immediately preceding exchange for a pronoun follow-up', () => {
    const query = buildRetrievalQuery('Как ее использовать?', [
      {role: 'user', content: 'Как продлить'},
      {role: 'assistant', content: 'Оплатите период в боте.'},
      {role: 'user', content: 'Как подключить'},
      {
        role: 'assistant',
        content: 'Используйте персональную ссылку для подключения.',
      },
    ]);

    expect(query).not.to.include('Как продлить');
    expect(query).not.to.include('Оплатите период');
    expect(query).to.include('Как подключить');
    expect(query).to.include('персональную ссылку');
  });

  it('combines rapid fragments that depend on one another', () => {
    expect(isContextDependentQuestion('Не работает')).to.equal(true);
    expect(isContextDependentQuestion('Что нужно сделать?')).to.equal(true);
    const query = buildRetrievalQuery('Не работает', [
      {role: 'user', content: 'У меня iPhone и приложение ExampleClient'},
    ]);
    expect(query).to.include('iPhone');
    expect(query).to.include('Не работает');
  });
});
