import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { loadEnv } from "@/config/env";
import { ApplicationModule } from "@/application.module";
import { ProcessWagerTransactionUseCase } from "@/modules/wagering/application/process-wager-transaction.use-case";
import { OutboxRelay } from "@/modules/wagering/application/outbox-relay";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import {
  AppLogger,
  Clock,
  EventPublisher,
  Metrics,
} from "@/shared/application/ports";
import {
  CLOCK,
  EVENT_PUBLISHER,
  LOGGER,
  METRICS,
  UNIT_OF_WORK,
} from "@/shared/application/tokens";
import { SQS_CLIENT } from "./sqs.module";
import {
  OUTBOX_LOOP_OPTIONS,
  OutboxPublisherService,
} from "./outbox-publisher.service";
import { SqsEventPublisher } from "./sqs-event-publisher";
import { SQS_CONSUMER_OPTIONS, SqsWagerConsumer } from "./sqs-wager-consumer";
import { WagerMessageHandler } from "./wager-message-handler";

/** Mensageria de saída: outbox -> SQS. Pré-requisitos: SqsModule e ObservabilityModule (globais) e MikroOrmModule. */
@Module({
  imports: [ApplicationModule],
  providers: [
    {
      provide: EVENT_PUBLISHER,
      useFactory: (client: SQSClient) =>
        new SqsEventPublisher(client, {
          queueUrl: loadEnv().SQS_EVENTS_QUEUE_URL,
        }),
      inject: [SQS_CLIENT],
    },
    {
      provide: OutboxRelay,
      useFactory: (
        uow: UnitOfWork,
        publisher: EventPublisher,
        clock: Clock,
        logger: AppLogger,
        metrics: Metrics,
      ) => {
        const env = loadEnv();
        return new OutboxRelay(uow, publisher, clock, logger, metrics, {
          batchSize: env.OUTBOX_BATCH_SIZE,
          leaseMs: env.OUTBOX_LEASE_MS,
        });
      },
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, LOGGER, METRICS],
    },
    {
      provide: OUTBOX_LOOP_OPTIONS,
      useFactory: () => {
        const env = loadEnv();
        return {
          pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
          enabled: env.OUTBOX_PUBLISHER_ENABLED,
        };
      },
    },
    OutboxPublisherService,
    {
      provide: WagerMessageHandler,
      useFactory: (
        useCase: ProcessWagerTransactionUseCase,
        logger: AppLogger,
        metrics: Metrics,
      ) => new WagerMessageHandler(useCase, logger, metrics),
      inject: [ProcessWagerTransactionUseCase, LOGGER, METRICS],
    },
    {
      provide: SQS_CONSUMER_OPTIONS,
      useFactory: () => {
        const env = loadEnv();
        return {
          enabled: env.SQS_CONSUMER_ENABLED,
          queueUrl: env.SQS_QUEUE_URL,
          dlqUrl: env.SQS_DLQ_URL,
          maxAttempts: env.SQS_MAX_ATTEMPTS,
          waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
          idleDelayMs: env.SQS_IDLE_DELAY_MS,
        };
      },
    },
    SqsWagerConsumer,
  ],
  exports: [EVENT_PUBLISHER, OutboxRelay],
})
export class MessagingModule {}
