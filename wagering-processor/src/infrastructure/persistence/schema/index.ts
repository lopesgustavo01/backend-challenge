import * as initial from "./initial-schema";
import * as reversalOncePerReference from "./reversal-once-per-reference";

/** Todas as migrations em ordem de aplicação. Fonte única para a migration do MikroORM e para os testes. */
export const schemaMigrations = [
  { name: "Migration20261008190000", up: initial.up, down: initial.down },
  {
    name: "Migration20261009083000",
    up: reversalOncePerReference.up,
    down: reversalOncePerReference.down,
  },
] as const;

export const allUp: string[] = schemaMigrations.flatMap((m) => m.up);
export const allDown: string[] = [...schemaMigrations]
  .reverse()
  .flatMap((m) => m.down);
