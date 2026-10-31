import { randomUUID } from 'node:crypto';

import type { Clock, IdGenerator } from '../../application/ports/system.port';
import type {
  ProviderAuthorization,
  ProviderIdentityPort,
} from '../../application/ports/provider-identity.port';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/*
  UUID v4 do `node:crypto`.

  As colunas de identidade interna são `uuid`, e é este o gerador. Os
  identificadores que vêm do provedor não passam por aqui — eles são
  `text`, porque o formato é dele e não nosso.
*/
export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/*
  Identidade do provedor — implementação no-op.

  Responde "canal sem identidade autenticada" para qualquer credencial, o que
  faz o caso de uso não ter nada a conferir. É a materialização da decisão
  registrada no `ARCHITECTURE.md`: autenticação não implementada, com o
  ponto de extensão explícito.

  Substituir esta classe por uma que valide JWT por JWKS liga a conferência do
  `providerId` sem alterar nenhum caso de uso.
*/
export class NoOpProviderIdentity implements ProviderIdentityPort {
  resolve(_credential: string | undefined): Promise<ProviderAuthorization> {
    return Promise.resolve({ authenticated: false });
  }
}
