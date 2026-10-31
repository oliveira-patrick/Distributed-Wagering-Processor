import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { MessagingModule } from '../../../infrastructure/messaging/messaging.module';
import { HealthController } from './health.controller';
import { PostgresHealthIndicator } from './postgres.health';
import { SqsHealthIndicator } from './sqs.health';

@Module({
  // O EntityManager vem do MikroOrmCoreModule, que é global.
  imports: [TerminusModule, MessagingModule],
  controllers: [HealthController],
  providers: [PostgresHealthIndicator, SqsHealthIndicator],
})
export class HealthModule {}
