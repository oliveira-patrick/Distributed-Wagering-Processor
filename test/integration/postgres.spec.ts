/*
  Integração contra um PostgreSQL REAL — nenhum mock.

    bun run infra:up && bun run test:integration

  Usa um banco próprio, derivado do configurado com o sufixo `_test`, criado
  e recriado a cada execução. Há um guarda que se recusa a apagar qualquer
  banco cujo nome não termine em `_test`: o custo do engano seria o banco de
  desenvolvimento.
*/
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import { buildMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import type { PostgresConfig } from '../../src/config/env.service';

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Variável ausente: ${name}`);
  }
  return value;
}

function baseConfig(database: string): PostgresConfig {
  return {
    host: env('POSTGRES_HOST'),
    port: Number(env('POSTGRES_PORT')),
    user: env('POSTGRES_USER'),
    password: env('POSTGRES_PASSWORD'),
    database,
  };
}

const testDatabase = `${env('POSTGRES_DB')}_test`;

let orm: MikroORM;

// Recria o banco de teste a partir do banco administrativo.
async function recreateTestDatabase(): Promise<void> {
  if (!testDatabase.endsWith('_test')) {
    throw new Error(
      `Recusando operar sobre "${testDatabase}": o nome precisa terminar em _test.`,
    );
  }

  const admin = await MikroORM.init(
    buildMikroOrmConfig(baseConfig(env('POSTGRES_DB')), { debug: false }),
  );
  try {
    const connection = admin.em.getConnection();
    await connection.execute(`drop database if exists "${testDatabase}"`);
    await connection.execute(`create database "${testDatabase}"`);
  } finally {
    await admin.close(true);
  }
}

beforeAll(async () => {
  await recreateTestDatabase();
  orm = await MikroORM.init(
    buildMikroOrmConfig(baseConfig(testDatabase), { debug: false }),
  );
}, 60_000);

afterAll(async () => {
  await orm.close(true);
});

describe('PostgreSQL', () => {
  it('aceita conexão e responde a uma consulta', async () => {
    const rows = await orm.em
      .getConnection()
      .execute<{ one: number }[]>('select 1 as one');

    expect(rows[0]?.one).toBe(1);
  });

  it('roda a versão 17 ou superior', async () => {
    /*
      `show server_version` não aceita alias de coluna; `current_setting`
      aceita, e devolve o mesmo valor.
    */
    const rows = await orm.em
      .getConnection()
      .execute<{ v: string }[]>(
        "select current_setting('server_version') as v",
      );
    const major = Number((rows[0]?.v ?? '0').split('.')[0]);

    expect(major).toBeGreaterThanOrEqual(17);
  });

  it('reverte uma transação por completo', async () => {
    const connection = orm.em.getConnection();
    await connection.execute(
      'create table if not exists rollback_probe (id int primary key)',
    );
    /*
      `em.execute` roda no contexto transacional do próprio EntityManager.
      `em.getConnection().execute` pegaria uma conexão do pool e escaparia da
      transação — o commit aconteceria mesmo com o rollback logo abaixo.
    */
    try {
      await orm.em.transactional(async (em) => {
        await em.execute('insert into rollback_probe values (1)');
        throw new Error('falha proposital');
      });
    } catch {
      // esperado: é o que dispara o rollback
    }

    const rows = await connection.execute<{ count: string }[]>(
      'select count(*)::text as count from rollback_probe',
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('pipeline de migrations', () => {
  it('aplica e reverte, deixando o schema no estado inicial', async () => {
    const migrator = orm.migrator;

    const pending = await migrator.getPending();
    await migrator.up();

    const executed = await migrator.getExecuted();
    expect(executed.length).toBe(pending.length);

    const applied = await orm.em
      .getConnection()
      .execute<{ count: string }[]>(
        "select count(*)::text as count from information_schema.tables where table_name = 'mikro_orm_migrations'",
      );
    expect(applied[0]?.count).toBe('1');

    await migrator.down({ to: 0 });
    const afterDown = await migrator.getExecuted();
    expect(afterDown.length).toBe(0);
  }, 60_000);
});
