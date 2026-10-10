import { Migration } from "@mikro-orm/migrations";
import { down, up } from "../schema/reversal-once-per-reference";

/** Reversão única por referência (qualquer tipo). SQL em schema/reversal-once-per-reference.ts. */
export class Migration20261009083000 extends Migration {
  override async up(): Promise<void> {
    for (const statement of up) this.addSql(statement);
  }

  override async down(): Promise<void> {
    for (const statement of down) this.addSql(statement);
  }
}
