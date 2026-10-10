import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { ApplicationModule } from "@/application.module";
import { AppExceptionFilter } from "./app-exception.filter";
import { CorrelationInterceptor } from "./correlation";
import { MetricsController } from "./metrics.controller";
import { CATCH_ALL_PATTERN, RequestLogMiddleware } from "./request-log.middleware";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

/** Adaptador HTTP. Filtro e interceptor são globais da aplicação (valem também para o /health). */
@Module({
  imports: [ApplicationModule],
  controllers: [WalletsController, WageringController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
  ],
})
export class HttpApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogMiddleware).forRoutes({ path: CATCH_ALL_PATTERN, method: RequestMethod.ALL });
  }
}
