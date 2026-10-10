import { SQL } from "bun";
import { MikroORM } from "@mikro-orm/postgresql";
import { allUp } from "@/infrastructure/persistence/schema";

/**
 * Banco descartável por arquivo de teste, em Postgres REAL (nunca mock). Usa o servidor do DATABASE_URL
 * (default: o do docker-compose), cria um banco novo e o derruba no fim: não toca nos dados de desenvolvimento.
 */
const BASE_URL = process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering";

export interface TestDb {
  readonly url: string;
  /** Conexão SQL direta, para ler o estado gravado (asserções) sem passar pelo código sob teste. */
  readonly sql: SQL;
  /** Uma "instância da aplicação": pool próprio de conexões, como um processo separado teria. */
  newOrm(): Promise<MikroORM>;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `wagering_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const urlFor = (database: string) => {
    const u = new URL(BASE_URL);
    u.pathname = `/${database}`;
    return u.toString();
  };

  const admin = new SQL(BASE_URL, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = urlFor(name);
  const sql = new SQL(url, { max: 10 });
  for (const statement of allUp) await sql.unsafe(statement);

  const orms: MikroORM[] = [];
  return {
    url,
    sql,
    async newOrm() {
      const orm = await MikroORM.init({
        clientUrl: url,
        entities: [],
        discovery: { warnWhenNoEntities: false },
        pool: { min: 0, max: 25 },
      });
      orms.push(orm);
      return orm;
    },
    async drop() {
      await Promise.all(orms.map((o) => o.close(true)));
      await sql.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}
