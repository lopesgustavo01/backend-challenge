import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { loadEnv } from "@/config/env";
import { SQS_CLIENT } from "@/infrastructure/messaging/sqs.module";

// Bun não emite design:paramtypes: toda injeção usa @Inject explícito.
@Controller("health")
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const body = { status: postgres && sqs ? "ok" : "unavailable", postgres, sqs };
    if (body.status !== "ok") throw new ServiceUnavailableException(body);
    return body;
  }

  private async checkPostgres(): Promise<boolean> {
    try {
      await this.orm.em.getConnection().execute("select 1");
      return true;
    } catch {
      return false;
    }
  }

  private async checkSqs(): Promise<boolean> {
    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: loadEnv().SQS_QUEUE_URL, AttributeNames: ["QueueArn"] }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
