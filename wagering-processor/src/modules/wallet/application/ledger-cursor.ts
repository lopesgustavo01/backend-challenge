import { InvalidCommandError } from "@/modules/wagering/application/errors";

/**
 * Cursor opaco, versionado e amarrado à wallet. Conteúdo: a `seq` do último lançamento entregue.
 *
 * Por que `seq` é uma chave de paginação estável: o lançamento é inserido com a wallet travada
 * (SELECT ... FOR UPDATE até o commit), então dentro de uma wallet a `seq` cresce na ordem do commit.
 * Nenhum lançamento com `seq` menor aparece depois de um maior, logo "seq > cursor" nunca pula nem repete linha.
 */
const VERSION = 1;
const MAX_LENGTH = 256;

export function encodeLedgerCursor(walletId: string, seq: string): string {
  return Buffer.from(
    JSON.stringify({ v: VERSION, w: walletId, s: seq }),
    "utf8",
  ).toString("base64url");
}

/** Devolve a `seq` do cursor. Qualquer coisa fora do formato (ou de outra wallet) é payload inválido. */
export function decodeLedgerCursor(cursor: string, walletId: string): string {
  const invalid = () => new InvalidCommandError("cursor is invalid");
  if (cursor.length === 0 || cursor.length > MAX_LENGTH) throw invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const c = parsed as { v?: unknown; w?: unknown; s?: unknown } | null;
  if (
    c === null ||
    typeof c !== "object" ||
    c.v !== VERSION ||
    typeof c.w !== "string" ||
    typeof c.s !== "string"
  ) {
    throw invalid();
  }
  if (!/^\d{1,18}$/.test(c.s)) throw invalid();
  if (c.w !== walletId)
    throw new InvalidCommandError("cursor belongs to another wallet");
  return c.s;
}
