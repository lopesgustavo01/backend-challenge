import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { loadEnv } from "@/config/env";

/**
 * Entidades de persistência serão definidas com EntitySchema, mantendo o domínio
 * livre de decorators do ORM. Preencher `entities` conforme os módulos forem criados.
 */
export default defineConfig({
  clientUrl: loadEnv().DATABASE_URL,
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: "./src/infrastructure/persistence/migrations",
    transactional: true,
    allOrNothing: true,
  },
  debug: false,
});
