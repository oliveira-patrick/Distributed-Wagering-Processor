import { Module } from '@nestjs/common';

import { SystemModule } from '../../../infrastructure/system/system.module';
import { MetricsController } from './metrics.controller';

/*
  Superfície de observabilidade, separada da de negócio.

  `/metrics` não é um endpoint de negócio — é instrumentação, e fica ao lado
  do health pelo mesmo motivo que ele: os dois servem a quem opera o
  processo, não a quem envia aposta, e nenhum dos dois exige autenticação.
*/
@Module({
  imports: [SystemModule],
  controllers: [MetricsController],
})
export class ObservabilityModule {}
