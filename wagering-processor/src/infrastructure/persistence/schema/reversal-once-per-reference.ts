/**
 * Migration 002: uma referência só pode ser revertida UMA vez, qualquer que seja o tipo de reversão.
 *
 * A regra 4 do desafio proíbe reverter duas vezes "pelo mesmo tipo de operação". Lida ao pé da letra,
 * uma BET poderia receber um REFUND e um ROLLBACK, creditando o valor duas vezes e violando a invariante
 * global de não duplicar créditos. Adotamos a leitura estrita e a aplicamos no schema.
 *
 * (REFUND de uma BET + ROLLBACK *desse REFUND* continua permitido: são referências diferentes.)
 */
export const up: string[] = [
  `DROP INDEX wager_tx_one_reversal_per_kind`,
  `CREATE UNIQUE INDEX wager_tx_one_reversal_per_reference
     ON wager_transactions (reference_transaction_id)
     WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
];

export const down: string[] = [
  `DROP INDEX wager_tx_one_reversal_per_reference`,
  `CREATE UNIQUE INDEX wager_tx_one_reversal_per_kind
     ON wager_transactions (reference_transaction_id, kind)
     WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
];
