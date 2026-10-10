import { z } from "zod";

/**
 * Só a FORMA do JSON (tipos). As regras (valor com 2 casas, moeda ISO, kind válido, tamanhos) são do use case,
 * que é compartilhado com o consumidor SQS: a validação de negócio é idêntica nos dois canais.
 */
export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const submitTransactionSchema = z.object({
  providerId: z.string(),
  externalTransactionId: z.string(),
  playerId: z.string(),
  walletId: z.string(),
  roundId: z.string(),
  gameId: z.string(),
  kind: z.string(),
  money: moneySchema,
  referenceExternalTransactionId: z.string().nullish(),
});

export const createWalletSchema = z.object({
  playerId: z.string(),
  initialBalance: moneySchema,
});
