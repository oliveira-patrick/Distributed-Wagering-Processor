import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import { UNIT_OF_WORK } from '../../application/ports/unit-of-work';
import { EnvService } from '../../config/env.service';
import { buildMikroOrmConfig } from './mikro-orm.config';
import { MikroOrmUnitOfWork } from './mikro-orm.unit-of-work';

/*
  Conexão com o PostgreSQL.

  `connect: false` é deliberado: a aplicação sobe mesmo com o banco fora do
  ar e passa a reportar `/health/ready` como indisponível, em vez de morrer
  na inicialização. Um orquestrador consegue distinguir "processo quebrado"
  de "dependência indisponível"; um processo que não sobe, não.

  O `driver` é declarado aqui, e não só dentro da factory, porque o
  MikroOrmCoreModule precisa dele antes de executá-la para registrar o
  `EntityManager` do PostgreSQL — e não o da classe base. `EntityManager` e
  `MikroORM` já vêm publicados para toda a aplicação, porque o core do
  MikroORM é `@Global()`.

  O que este módulo exporta é a fronteira transacional, sob o token
  `UNIT_OF_WORK`. Nenhum repositório é exportado: eles existem somente dentro
  de `UnitOfWork.run`, e é essa restrição que impede uma escrita de escapar
  da transação.
*/
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        ...buildMikroOrmConfig(env.postgres, { debug: !env.isProduction }),
        connect: false,
      }),
    }),
  ],
  providers: [{ provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork }],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
