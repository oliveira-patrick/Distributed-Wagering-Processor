/*
  Reconhecimento de falha de transporte.

  Teste de unidade puro: objetos de erro construídos à mão, nenhuma rede.

  O que está em jogo é a diferença entre 503 e 500 — entre dizer ao provedor
  "reenvie" e "não reenvie, isto é bug". Um falso positivo convida a reenviar
  uma operação que talvez tenha sido aplicada; um falso negativo faz o
  provedor desistir de uma que daria certo.
*/
import { describe, expect, it } from 'bun:test';

import { DeadlineExceededError } from '../../src/shared/with-deadline';
import { isTransportFailure } from '../../src/shared/transport-failure';

function withCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('é falha de transporte', () => {
  it('socket recusado, resetado ou estourado', () => {
    for (const code of [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'EAI_AGAIN',
    ]) {
      expect(isTransportFailure(withCode(code))).toBe(true);
    }
  });

  it('SQLSTATE de classe 08, 53 e 57', () => {
    // 08 conexão, 53 recursos esgotados, 57 intervenção do operador — inclui
    // `57P01`, que é o PostgreSQL sendo desligado.
    for (const code of ['08006', '08003', '53300', '57P01', '57P03']) {
      expect(isTransportFailure(withCode(code))).toBe(true);
    }
  });

  it('estouro de prazo próprio', () => {
    expect(isTransportFailure(new DeadlineExceededError('SQS', 2000))).toBe(
      true,
    );
  });

  it('TimeoutError e AbortError do SDK', () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      expect(isTransportFailure(Object.assign(new Error('x'), { name }))).toBe(
        true,
      );
    }
  });

  it('erro envolvido, encontrado pela cadeia de causas', () => {
    // O erro do driver raramente é o de topo: o ORM envolve, e o `pg` fica
    // abaixo em `cause` ou `previous`.
    const driver = withCode('08006');

    expect(
      isTransportFailure(Object.assign(new Error('wrap'), { cause: driver })),
    ).toBe(true);
    expect(
      isTransportFailure(
        Object.assign(new Error('wrap'), { previous: driver }),
      ),
    ).toBe(true);
  });

  it('AggregateError, que é como falha de conexão chega no Node', () => {
    // Uma tentativa por família de endereço, IPv4 e IPv6, com a causa real em
    // `errors` e a mensagem de topo vazia.
    const aggregate = new AggregateError([withCode('ECONNREFUSED')], '');

    expect(isTransportFailure(aggregate)).toBe(true);
  });
});

describe('não é falha de transporte', () => {
  it('violação de unicidade', () => {
    // 23505 é erro de integridade, e ele é caminho de negócio neste sistema —
    // é o que decide o vencedor da idempotência. Marcar como transitório faria
    // o provedor reenviar uma operação já aplicada.
    expect(isTransportFailure(withCode('23505'))).toBe(false);
  });

  it('violação de check e de chave estrangeira', () => {
    for (const code of ['23514', '23503', '23502']) {
      expect(isTransportFailure(withCode(code))).toBe(false);
    }
  });

  it('erro de sintaxe SQL', () => {
    expect(isTransportFailure(withCode('42601'))).toBe(false);
  });

  it('erro comum sem código', () => {
    expect(isTransportFailure(new Error('qualquer coisa'))).toBe(false);
  });

  it('valores que não são erro', () => {
    for (const value of [undefined, null, 'ECONNREFUSED', 42]) {
      expect(isTransportFailure(value)).toBe(false);
    }
  });

  it('código que só parece SQLSTATE', () => {
    // Cinco caracteres começando em 08 é SQLSTATE; `08` solto, não.
    expect(isTransportFailure(withCode('08'))).toBe(false);
    expect(isTransportFailure(withCode('080060'))).toBe(false);
  });
});
