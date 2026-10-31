import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { EnvService } from './config/env.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  /*
    Sem isto, onApplicationShutdown não roda e o SIGTERM encerra o processo
    com trabalho em andamento, e o shutdown precisa ser gracioso.
  */
  app.enableShutdownHooks();

  const env = app.get(EnvService);
  await app.listen(env.appPort);

  Logger.log(
    `API ouvindo em http://localhost:${String(env.appPort)} (${env.nodeEnv})`,
    'Bootstrap',
  );
}

await bootstrap();
