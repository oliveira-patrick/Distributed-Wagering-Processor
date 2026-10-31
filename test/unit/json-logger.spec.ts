import { describe, expect, it } from 'bun:test';

import { JsonLogger } from '../../src/infrastructure/observability/json-logger';

/*
  Teste de unidade puro. O `sink` e o relógio entram pelo construtor porque
  são parâmetros do objeto, não dublês: o logger de produção recebe
  `process.stdout.write` e `new Date()` pelos mesmos dois argumentos.
*/

const FIXED = new Date('2026-10-30T12:00:00.000Z');

function collector(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line): void => void lines.push(line) };
}

function records(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('envelope', () => {
  it('emite uma linha JSON por registro', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('info', sink, () => FIXED);

    logger.info('transação aplicada');

    expect(lines).toHaveLength(1);
    expect(records(lines)[0]).toEqual({
      level: 'info',
      time: '2026-10-30T12:00:00.000Z',
      msg: 'transação aplicada',
    });
  });

  it('carimba o nível em cada registro', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('trace', sink, () => FIXED);

    logger.info('a');
    logger.warn('b');
    logger.error('c');

    expect(records(lines).map((record) => record.level)).toEqual([
      'info',
      'warn',
      'error',
    ]);
  });

  it('usa ISO-8601 com milissegundos no tempo', () => {
    const { lines, sink } = collector();
    new JsonLogger('info', sink, () => FIXED).info('x');

    expect(records(lines)[0]?.time).toBe('2026-10-30T12:00:00.000Z');
  });
});

describe('campos de correlação', () => {
  it('põe os campos no topo, não aninhados', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('info', sink, () => FIXED);

    logger.info('mensagem consumida', {
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
    });

    // No topo para que o coletor consulte por correlationId sem precisar
    // conhecer a forma do nosso envelope.
    expect(records(lines)[0]).toEqual({
      level: 'info',
      time: '2026-10-30T12:00:00.000Z',
      msg: 'mensagem consumida',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
    });
  });

  it('omite campo indefinido em vez de emitir null', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('info', sink, () => FIXED);

    logger.info('x', { transactionId: 'tx-1', walletId: undefined });

    // Um null obrigaria quem consulta a tratar dois valores para
    // "não informado".
    expect(records(lines)[0]).not.toHaveProperty('walletId');
    expect(records(lines)[0]?.transactionId).toBe('tx-1');
  });

  it('aceita número e booleano, que são contagem e sinalizador', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('info', sink, () => FIXED);

    logger.warn('divergência', { checkedEntries: 42, consistent: false });

    expect(records(lines)[0]?.checkedEntries).toBe(42);
    expect(records(lines)[0]?.consistent).toBe(false);
  });

  it('não deixa o contexto sobrescrever o envelope', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('info', sink, () => FIXED);

    logger.error('falhou', { level: 'info', msg: 'outra', time: 'ontem' });

    const record = records(lines)[0];
    expect(record?.level).toBe('error');
    expect(record?.msg).toBe('falhou');
    expect(record?.time).toBe('2026-10-30T12:00:00.000Z');
    expect(record?._level).toBe('info');
  });
});

describe('nível configurado', () => {
  it('descarta o que é mais verboso que o nível', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('warn', sink, () => FIXED);

    logger.info('não sai');
    logger.warn('sai');
    logger.error('sai');

    expect(records(lines).map((record) => record.msg)).toEqual(['sai', 'sai']);
  });

  it('em error, só erro passa', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('error', sink, () => FIXED);

    logger.info('a');
    logger.warn('b');
    logger.error('c');

    expect(lines).toHaveLength(1);
    expect(records(lines)[0]?.msg).toBe('c');
  });

  it('em fatal, nem erro passa — e isso é o pedido, não um bug', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('fatal', sink, () => FIXED);

    logger.error('c');

    expect(lines).toHaveLength(0);
  });

  it('em debug e trace, tudo que a porta expõe passa', () => {
    for (const level of ['debug', 'trace'] as const) {
      const { lines, sink } = collector();
      const logger = new JsonLogger(level, sink, () => FIXED);

      logger.info('a');
      logger.warn('b');
      logger.error('c');

      expect(lines).toHaveLength(3);
    }
  });
});

describe('formato', () => {
  it('escapa quebra de linha, de modo que um registro nunca vire dois', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('info', sink, () => FIXED);

    logger.info('primeira\nsegunda');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(records(lines)[0]?.msg).toBe('primeira\nsegunda');
  });

  it('produz linha que sempre faz parse como JSON', () => {
    const { lines, sink } = collector();
    const logger = new JsonLogger('info', sink, () => FIXED);

    logger.info('aspas " e barra \\ e acento ç', { providerId: 'a"b' });

    expect(() => records(lines)).not.toThrow();
    expect(records(lines)[0]?.providerId).toBe('a"b');
  });
});
