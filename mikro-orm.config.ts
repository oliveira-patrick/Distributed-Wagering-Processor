/**
 * Ponto de entrada da CLI do MikroORM.
 *
 * A aplicação constrói a mesma configuração a partir do EnvService; aqui o
 * ambiente é lido direto de `process.env`, que o Bun já popula a partir do
 * `.env`. Executar com:
 *
 *   bun run migration:up
 */
import { buildMikroOrmConfig } from './src/infrastructure/persistence/mikro-orm.config';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Variável de ambiente ausente: ${name}. Copie .env.example para .env.`,
    );
  }
  return value;
}

export default buildMikroOrmConfig(
  {
    host: required('POSTGRES_HOST'),
    port: Number(required('POSTGRES_PORT')),
    user: required('POSTGRES_USER'),
    password: required('POSTGRES_PASSWORD'),
    database: required('POSTGRES_DB'),
  },
  { debug: process.env.NODE_ENV === 'development' },
);
