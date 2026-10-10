import { EventContext, IntegrationEvent } from "@/shared/messaging/integration-event";
import { MoneyProps } from "@/shared/domain/money";
import { FailureCode } from "../failure-code";
import { WagerTransaction, WagerTransactionKind } from "../wager-transaction";

// A classe vive no módulo wallet; o re-export mantém um único ponto de importação dos eventos financeiros.
export { WalletBalanceChanged } from "@/modules/wallet/domain/events/wallet-balance-changed";

export interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Saldo da wallet observado ao decidir esta transação. */
  balance?: MoneyProps;
}

function baseData(t: WagerTransaction, balance: MoneyProps | undefined): WagerTransactionEventData {
  return {
    transactionId: t.id,
    walletId: t.walletId,
    playerId: t.playerId,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    roundId: t.roundId,
    kind: t.kind,
    money: t.money.toJSON(),
    ...(balance === undefined ? {} : { balance }),
  };
}

/** Qualquer transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(t: WagerTransaction, balance: MoneyProps | undefined, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: t.walletId, data: baseData(t, balance) });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

/** Violação de regra de negócio. Não altera saldo nem gera ledger. O failureCode vem da própria transação. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(t: WagerTransaction, balance: MoneyProps | undefined, ctx: EventContext): WagerTransactionRejected {
    if (t.failureCode === undefined) {
      throw new Error(`Transaction ${t.id} has no failureCode; it cannot be published as rejected`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: t.walletId,
      data: { ...baseData(t, balance), failureCode: t.failureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

/** A transação referenciada ainda não chegou; o worker reprocessa com backoff. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(t: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: t.walletId,
      data: { ...baseData(t, undefined), referenceExternalTransactionId: t.referenceExternalTransactionId ?? "" },
    });
  }
}
