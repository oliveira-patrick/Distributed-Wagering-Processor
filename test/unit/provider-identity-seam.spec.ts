/*
  A costura de autenticação é real, não decorativa.

  **ESTE ARQUIVO USA DUBLÊS, declarados.** O `UnitOfWork` abaixo é uma
  sentinela: ele **lança** se for chamado. Não substitui o PostgreSQL em
  afirmação nenhuma sobre persistência — ele existe para provar o contrário,
  que a decisão de identidade acontece **antes** de qualquer transação abrir.
  Com um banco de verdade esse "antes" seria invisível.

  A decisão registrada no `ARCHITECTURE.md` é não implementar
  autenticação, e em troca deixar o ponto de extensão explícito no código.
  Um ponto de extensão que ninguém chama é só uma interface pendurada — daí
  este teste.
*/
import { describe, expect, it } from 'bun:test';

import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/shared/failure-code';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import type {
  ProviderAuthorization,
  ProviderIdentityPort,
} from '../../src/application/ports/provider-identity.port';
import type {
  Clock,
  IdGenerator,
} from '../../src/application/ports/system.port';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import type { SubmitWagerTransactionInput } from '../../src/application/contracts/submit-wager-transaction.command';
import { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/submit-wager-transaction.use-case';
import { NoOpProviderIdentity } from '../../src/infrastructure/system/system.providers';

const REACHED_TRANSACTION = 'o caso de uso abriu transação';

// DUBLÊ-sentinela: acusa que a execução chegou à fronteira transacional.
const unitOfWork: UnitOfWork = {
  run: () => {
    throw new Error(REACHED_TRANSACTION);
  },
};

const clock: Clock = { now: () => new Date('2026-10-30T12:00:00.000Z') };

const ids: IdGenerator = ((): IdGenerator => {
  let counter = 0;
  return {
    next: (): string => {
      counter += 1;
      return `id-${String(counter)}`;
    },
  };
})();

// DUBLÊ: identidade autenticada, como um IdP devolveria.
function authenticatedAs(providerId: string): ProviderIdentityPort {
  return {
    resolve: (): Promise<ProviderAuthorization> =>
      Promise.resolve({ authenticated: true, providerId }),
  };
}

function input(
  overrides: Partial<SubmitWagerTransactionInput> = {},
): SubmitWagerTransactionInput {
  return {
    idempotencyKey: 'provider-a:transaction-123',
    correlationId: 'corr-1',
    credential: 'Bearer token',
    payload: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    },
    ...overrides,
  };
}

function useCaseWith(
  identity: ProviderIdentityPort,
): SubmitWagerTransactionUseCase {
  return new SubmitWagerTransactionUseCase(unitOfWork, identity, clock, ids);
}

describe('ProviderIdentityPort — identidade autenticada', () => {
  it('recusa quando o providerId do token não bate com o do payload', async () => {
    const result = await useCaseWith(authenticatedAs('provider-b')).execute(
      input(),
    );

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.failureCode).toBe(FailureCode.VALIDATION_FAILED);
    expect(result.detail).toContain('provider-b');
    expect(result.detail).toContain('provider-a');
  });

  it('recusa antes de abrir transação', async () => {
    // A sentinela não foi acionada: nada de banco foi tocado. É o que faz a
    // conferência ser barata e segura — um payload com identidade divergente
    // não consome lock de wallet nem conexão.
    const result = await useCaseWith(authenticatedAs('provider-b')).execute(
      input(),
    );

    expect(result.outcome).toBe('refused');
  });

  it('segue em frente quando o providerId confere', async () => {
    // Chegar à sentinela é o resultado esperado: a identidade conferiu e o
    // caso de uso avançou para a transação.
    await expectReachesTransaction(useCaseWith(authenticatedAs('provider-a')));
  });
});

describe('ProviderIdentityPort — implementação no-op de hoje', () => {
  it('não bloqueia nada: o canal não traz identidade', async () => {
    await expectReachesTransaction(useCaseWith(new NoOpProviderIdentity()));
  });

  it('responde "sem identidade" para qualquer credencial', async () => {
    const identity = new NoOpProviderIdentity();

    for (const credential of [undefined, '', 'Bearer qualquer-coisa']) {
      expect(await identity.resolve(credential)).toEqual({
        authenticated: false,
      });
    }
  });
});

async function expectReachesTransaction(
  useCase: SubmitWagerTransactionUseCase,
): Promise<void> {
  let failure: unknown;
  try {
    await useCase.execute(input());
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(REACHED_TRANSACTION);
}
