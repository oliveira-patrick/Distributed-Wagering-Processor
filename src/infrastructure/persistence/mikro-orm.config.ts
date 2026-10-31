import { UnderscoreNamingStrategy } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Options } from '@mikro-orm/postgresql';

import type { PostgresConfig } from '../../config/env.service';
import { persistenceEntities } from './entities';

/*
  Configuração única do MikroORM, consumida por dois chamadores: o módulo
  Nest, na inicialização da aplicação, e a CLI, ao criar e aplicar
  migrations. Manter uma só definição evita que a aplicação e as migrations
  divirjam sobre o schema.

  As entidades registradas são os **modelos de persistência**, não as
  classes de domínio — ver `entities/index.ts` para a razão e o ADR-006.
*/
export function buildMikroOrmConfig(
  postgres: PostgresConfig,
  options: { readonly debug: boolean },
): Options {
  return defineConfig({
    host: postgres.host,
    port: postgres.port,
    user: postgres.user,
    password: postgres.password,
    dbName: postgres.database,

    entities: persistenceEntities,

    /*
      Declarada em vez de herdada do driver: o nome das colunas é contrato
      com a migration, e contrato não deve depender de um default que pode
      mudar entre versões.
    */
    namingStrategy: UnderscoreNamingStrategy,

    extensions: [Migrator],
    migrations: {
      path: './src/infrastructure/persistence/migrations',
      pathTs: './src/infrastructure/persistence/migrations',
      tableName: 'mikro_orm_migrations',
      emit: 'ts',
      /*
        Cada migration roda dentro da própria transação e, se qualquer uma
        falhar, o lote inteiro é revertido: nunca um schema pela metade.
      */
      transactional: true,
      allOrNothing: true,
      /*
        Snapshot desligado: o diff é calculado contra o banco real, e não
        contra um arquivo que pode ficar defasado em relação a ele.
      */
      snapshot: false,
    },

    // O schema é propriedade das migrations. Nada de sincronização automática.
    debug: options.debug,
    forceUtcTimezone: true,
  });
}
