/*
  Banco de teste descartável, por arquivo de teste.

  Cada arquivo recebe um banco próprio, derivado do configurado, recriado no
  início da execução e com as migrations aplicadas. Banco próprio por arquivo
  evita que um teste veja linha deixada por outro e permite rodá-los sem
  ordem combinada.

  Há uma trava que recusa qualquer nome que não termine em `_test`: o custo
  do engano seria o banco de desenvolvimento.
*/
import { MikroORM } from '@mikro-orm/postgresql';

import type { PostgresConfig } from '../../../src/config/env.service';
import { buildMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Variável ausente: ${name}`);
  }
  return value;
}

/*
  Capturado no carregamento do módulo, de propósito.

  O teste de API precisa apontar `POSTGRES_DB` para o banco descartável antes
  de importar a aplicação, e os arquivos de teste rodam no mesmo processo. Se
  o nome base fosse lido a cada chamada, um arquivo que rodasse depois dessa
  mudança derivaria `..._api_test_constraints_test` — nome errado, ainda
  terminando em `_test`, e portanto passando pela trava sem avisar.
*/
const BASE_DATABASE = env('POSTGRES_DB');

function configFor(database: string): PostgresConfig {
  return {
    host: env('POSTGRES_HOST'),
    port: Number(env('POSTGRES_PORT')),
    user: env('POSTGRES_USER'),
    password: env('POSTGRES_PASSWORD'),
    database,
  };
}

export interface TestDatabase {
  readonly orm: MikroORM;
  readonly name: string;
  close(): Promise<void>;
}

export async function createTestDatabase(
  suffix: string,
): Promise<TestDatabase> {
  const name = `${BASE_DATABASE}_${suffix}_test`;

  if (!name.endsWith('_test')) {
    throw new Error(
      `Recusando operar sobre "${name}": o nome precisa terminar em _test.`,
    );
  }

  const admin = await MikroORM.init(
    buildMikroOrmConfig(configFor(BASE_DATABASE), { debug: false }),
  );
  try {
    const connection = admin.em.getConnection();
    await connection.execute(`drop database if exists "${name}"`);
    await connection.execute(`create database "${name}"`);
  } finally {
    await admin.close(true);
  }

  const orm = await MikroORM.init(
    buildMikroOrmConfig(configFor(name), { debug: false }),
  );
  await orm.migrator.up();

  return {
    orm,
    name,
    close: async (): Promise<void> => {
      await orm.close(true);
    },
  };
}
