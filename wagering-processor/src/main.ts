import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM: base para o graceful shutdown do consumer/publisher
  await app.listen(env.PORT);
}

bootstrap();
