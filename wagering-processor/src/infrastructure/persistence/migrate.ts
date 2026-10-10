import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("uso: bun migrate.ts <up|down>");
  process.exit(1);
}

const orm = await MikroORM.init(config);
try {
  const migrator = orm.migrator;
  const done = direction === "up" ? await migrator.up() : await migrator.down();
  console.log(`${direction}: ${done.length} migration(s)`);
} finally {
  await orm.close(true);
}
