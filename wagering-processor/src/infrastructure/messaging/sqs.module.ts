import { Global, Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { loadEnv } from "@/config/env";

export const SQS_CLIENT = Symbol("SQS_CLIENT");

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: () => {
        const env = loadEnv();
        return new SQSClient({
          region: env.AWS_REGION,
          endpoint: env.AWS_ENDPOINT_URL,
        });
      },
    },
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
