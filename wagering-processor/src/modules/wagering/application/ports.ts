import { Money } from "@/shared/domain/money";
import { InboxMessage } from "@/shared/messaging/inbox-message";
import { OutboxMessage } from "@/shared/messaging/outbox-message";
import { Wallet } from "@/modules/wallet/domain/wallet";
import { WalletLedgerEntry } from "@/modules/wallet/domain/wallet-ledger-entry";
import { WagerTransaction } from "../domain/wager-transaction";

/** Transação + o que é persistido ao lado dela e não pertence ao agregado. */
export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  /** Saldo observado quando a transação foi decidida; o replay devolve este valor (regra 7). */
  balanceAfter?: Money;
  referenceAttempts: number;
  nextAttemptAt?: Date;
}

export interface TransactionExtras {
  balanceAfter?: Money;
  referenceAttempts?: number;
  nextAttemptAt?: Date;
}

export interface WalletRepository {
  /** SELECT ... FOR UPDATE: serializa por walletId. Sempre o PRIMEIRO acesso à wallet na transação. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  find(id: string): Promise<Wallet | undefined>;
  /** false se (player, moeda) já existe. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  /** UPDATE ... WHERE version = expectedVersion. Lança TransientProcessingError se nenhuma linha casar. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /** INSERT ... ON CONFLICT DO NOTHING (qualquer constraint única). false se perdeu a corrida. */
  insertIfAbsent(
    transaction: WagerTransaction,
    extras: TransactionExtras,
  ): Promise<boolean>;
  update(
    transaction: WagerTransaction,
    extras: TransactionExtras,
  ): Promise<void>;
  findById(id: string): Promise<StoredWagerTransaction | undefined>;
  findByIdempotencyKey(
    key: string,
  ): Promise<StoredWagerTransaction | undefined>;
  findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined>;
  /**
   * Reversão PROCESSED (REFUND ou ROLLBACK) desta referência. Leitura estrita da regra 4: uma referência
   * é revertida uma única vez, qualquer que seja o tipo, senão BET + REFUND + ROLLBACK creditaria duas
   * vezes. O índice parcial `wager_tx_one_reversal_per_reference` (migration 002) é a garantia final.
   */
  findProcessedReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  /**
   * PENDING_REFERENCE com tentativa vencida, mais antigas primeiro. SEM lock: serve só para descobrir candidatos.
   * Quem decide é quem trava a wallet e relê a transação (a ordem de locks é sempre wallet -> transação).
   */
  findDuePendingReference(
    now: Date,
    limit: number,
  ): Promise<DuePendingReference[]>;

  pendingReferenceStats(now: Date): Promise<PendingReferenceStats>;
}

export interface DuePendingReference {
  id: string;
  walletId: string;
}

/** Lançamento + a `seq` que o banco lhe deu (chave estável de ordenação e de cursor). */
export interface LedgerPageItem {
  seq: string;
  entry: WalletLedgerEntry;
}

export interface LedgerReconciliation {
  storedBalance: Money;
  /** Soma do ledger (créditos - débitos). Pode ser negativa se o ledger estiver corrompido. */
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Em ordem de `seq` crescente, só os de `seq > afterSeq` quando informado. */
  listByWallet(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPageItem[]>;
  /** undefined se a wallet não existe. Saldo e soma saem do MESMO statement (mesmo snapshot). */
  reconcile(walletId: string): Promise<LedgerReconciliation | undefined>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;

  /**
   * Reivindica até `limit` mensagens vencidas (SELECT ... FOR UPDATE SKIP LOCKED) e as "aluga":
   * empurra next_attempt_at para now + leaseMs na mesma transação. Instâncias concorrentes nunca recebem a mesma
   * mensagem; se quem alugou morrer, o aluguel expira e outra instância assume. Devolve em ordem de `seq`.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;

  /** Só marca se ainda estiver pendente (idempotente). true se esta chamada foi quem marcou. */
  markPublished(id: string, at: Date): Promise<boolean>;

  /** Grava o resultado de `scheduleRetry` (attempts e next_attempt_at já calculados no domínio) e o último erro. */
  saveRetry(message: OutboxMessage, error: string): Promise<void>;

  /** Retrato do backlog para observabilidade (lag = idade da mensagem pendente mais antiga). */
  stats(now: Date): Promise<OutboxStats>;
}

export interface OutboxStats {
  pending: number;
  /** Pendentes que já falharam ao menos uma vez (broker com problema, mensagem venenosa...). */
  failing: number;
  oldestPendingAgeSeconds: number;
}

export interface PendingReferenceStats {
  count: number;
  oldestAgeSeconds: number;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. false se (consumer, messageId) já foi recebida. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface WageringRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/** Uma chamada = uma transação SQL. Tudo ou nada. */
export interface UnitOfWork {
  run<T>(work: (repositories: WageringRepositories) => Promise<T>): Promise<T>;
}
