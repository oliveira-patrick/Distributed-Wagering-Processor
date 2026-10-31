import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { UseCasesModule } from '../../infrastructure/composition/use-cases.module';
import { SystemModule } from '../../infrastructure/system/system.module';
import { TransportFailureFilter } from './transport-failure.filter';
import {
  ProviderTransactionsController,
  WageringController,
} from './wagering.controller';
import { WalletsController } from './wallets.controller';

/*
  Os sete endpoints de negócio, fora os dois de health.

  O filtro entra por `APP_FILTER`, e não por `useGlobalFilters` no `main.ts`,
  para que um módulo de teste que importe este também receba o mapeamento de
  falha de transporte. Registrar no bootstrap deixaria os testes de endpoint
  exercitando um comportamento diferente do de produção.
*/
@Module({
  /*
    `SystemModule` entra por causa do `METRICS` do controller de submissão: é
    o ponto de entrada que sabe a própria origem, e por isso é ele quem
    registra a métrica em vez do caso de uso, compartilhado com a fila.
  */
  imports: [UseCasesModule, SystemModule],
  controllers: [
    WalletsController,
    WageringController,
    ProviderTransactionsController,
  ],
  providers: [{ provide: APP_FILTER, useClass: TransportFailureFilter }],
})
export class ApiModule {}
