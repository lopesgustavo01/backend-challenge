import { Migration } from "@mikro-orm/migrations";
import { down, up } from "../schema/initial-schema";

/** Schema inicial. O SQL vive em schema/initial-schema.ts (testado contra Postgres real). */
export class Migration20261008190000 extends Migration {
  override async up(): Promise<void> {
    for (const statement of up) this.addSql(statement);
  }

  override async down(): Promise<void> {
    for (const statement of down) this.addSql(statement);
  }
}
