import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { validateEnv } from './env.schema';
import { EnvService } from './env.service';

/*
  Global porque praticamente todo adaptador precisa de configuração, e
  reimportar este módulo em cada um deles não acrescenta informação.
*/
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
  ],
  providers: [EnvService],
  exports: [EnvService],
})
export class ConfigModule {}
