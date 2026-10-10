import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import mikroOrmConfig from "@/infrastructure/persistence/mikro-orm.config";
import { SqsModule } from "@/infrastructure/messaging/sqs.module";
import { WorkersModule } from "@/infrastructure/workers/workers.module";
import { MessagingModule } from "@/infrastructure/messaging/messaging.module";
import { HealthModule } from "@/health/health.module";
import { HttpApiModule } from "@/http/http-api.module";
import { ObservabilityModule } from "@/shared/observability/observability.module";

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), ObservabilityModule, SqsModule, MessagingModule, WorkersModule, HealthModule, HttpApiModule],
})
export class AppModule {}
