import { Inject, Injectable, Optional } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { DomainError } from "@/shared/domain/errors";
import { TransientProcessingError } from "@/modules/wagering/application/errors";
import {
  UnitOfWork,
  WageringRepositories,
} from "@/modules/wagering/application/ports";
import { PostgresInboxRepository } from "./inbox.repository";
import { PostgresLedgerRepository } from "./ledger.repository";
import { PostgresOutboxRepository } from "./outbox.repository";
import { PostgresWagerTransactionRepository } from "./wager-transaction.repository";
import { PostgresWalletRepository } from "./wallet.repository";
import { Executor, isTransientDatabaseError } from "./sql";

export const UNIT_OF_WORK_OPTIONS = Symbol("UNIT_OF_WORK_OPTIONS");

export interface UnitOfWorkOptions {
  /**
   * Quanto esperar por um lock antes de desistir (55P03 -> TransientProcessingError -> 503).
   * Evita que uma wallet "quente" ou uma transação travada prenda conexões do pool indefinidamente.
   */
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Uma chamada a `run` = uma transação SQL (READ COMMITTED) numa conexão própria do pool, via fork do
 * EntityManager. Domínio e use cases só enxergam as portas; todo SQL fica nos repositórios desta pasta.
 */
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Optional() @Inject(UNIT_OF_WORK_OPTIONS) options?: UnitOfWorkOptions,
  ) {
    const timeout = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1)
      throw new Error("lockTimeoutMs must be a positive integer");
    this.lockTimeoutMs = timeout;
  }

  async run<T>(
    work: (repositories: WageringRepositories) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // valor validado como inteiro no construtor: seguro interpolar (SET não aceita parâmetros)
        await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
        return work(repositoriesFor(em));
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Erros de domínio atravessam intactos; falhas transitórias de infraestrutura viram um erro explícito. */
  private translate(error: unknown): unknown {
    if (error instanceof DomainError || !isTransientDatabaseError(error))
      return error;
    const translated = new TransientProcessingError(
      "Database is temporarily unavailable; retry is safe",
    );
    Object.defineProperty(translated, "cause", {
      value: error,
      enumerable: false,
    });
    return translated;
  }
}

function repositoriesFor(em: Executor): WageringRepositories {
  return {
    wallets: new PostgresWalletRepository(em),
    transactions: new PostgresWagerTransactionRepository(em),
    ledger: new PostgresLedgerRepository(em),
    outbox: new PostgresOutboxRepository(em),
    inbox: new PostgresInboxRepository(em),
  };
}
