import { Money } from "@/shared/domain/money";
import { LedgerDirection } from "@/modules/wallet/domain/wallet-ledger-entry";
import { FailureCode, isInfrastructureFailure } from "./failure-code";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./wagering.errors";

export enum WagerTransactionKind {
  Opening = "OPENING", // interno: crédito de abertura da wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED", // terminal
  Rejected = "REJECTED", // terminal
  Failed = "FAILED", // terminal
}

/**
 * Transições válidas:
 *   PENDING           -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED: terminais
 */
const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** O que cada tipo de reversão pode referenciar. */
const REVERSIBLE_BY_REFUND: ReadonlySet<WagerTransactionKind> = new Set([WagerTransactionKind.Bet]);
const REVERSIBLE_BY_ROLLBACK: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Entrada externa (API/fila). Nasce em PENDING. OPENING é proibido aqui. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    return WagerTransaction.build(props);
  }

  /** Crédito interno de abertura da wallet. Sem referência. */
  static createOpening(props: Omit<CreateWagerTransactionProps, "kind" | "referenceExternalTransactionId">): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId: ref } = props;

    // LOSS não move saldo e pode vir com valor zero; todo o resto precisa ser positivo.
    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be strictly positive`);
    }
    if (money.isNegative()) {
      throw new InvalidWagerTransactionError("Amount cannot be negative");
    }

    const hasRef = ref !== undefined && ref !== "";
    if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && !hasRef) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }
    if ((kind === WagerTransactionKind.Bet || kind === WagerTransactionKind.Opening) && ref !== undefined) {
      throw new InvalidWagerTransactionError(`${kind} cannot have a reference`);
    }

    return WagerTransaction.rehydrate({ ...props, status: WagerTransactionStatus.Pending });
  }

  /** Reconstrução a partir da persistência — não revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  /** Só a partir de PENDING, e só se a transação aponta para uma referência. */
  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`Cannot move ${this._status} to PENDING_REFERENCE`);
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /** Violação de regra de negócio. Aceita apenas códigos de negócio. */
  reject(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    if (isInfrastructureFailure(code)) {
      throw new InvalidWagerTransactionError(`${code} is an infrastructure failure; use fail()`);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  /** Erro permanente de infraestrutura. Aceita apenas códigos de infra. */
  fail(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    if (!isInfrastructureFailure(code)) {
      throw new InvalidWagerTransactionError(`${code} is a business rejection; use reject()`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger.
   *  BET -> DEBIT; WIN, REFUND, OPENING -> CREDIT; ROLLBACK -> inverso da referência.
   * LOSS não gera lançamento: chamar aqui é erro de programação.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError("ROLLBACK needs its reference to define the direction");
        }
        if (!REVERSIBLE_BY_ROLLBACK.has(reference.kind)) {
          throw new InvalidWagerTransactionError(`ROLLBACK cannot reverse ${reference.kind}`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS does not generate a ledger entry");
    }
  }

  /**
   * Regras 2, 3 e 5 da seção 7 aplicadas à referência já localizada.
   * Devolve o FailureCode da primeira violação, ou undefined se a referência é válida.
   * "Já revertida" (regra 4) depende de outras linhas e é garantida pelo banco + use case.
   */
  validateReference(reference: WagerTransaction): FailureCode | undefined {
    if (!this.requiresReference()) return undefined;

    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (!this.isInScopeOf(reference)) return FailureCode.ReferenceMismatch;

    const allowed = this.kind === WagerTransactionKind.Refund ? REVERSIBLE_BY_REFUND : REVERSIBLE_BY_ROLLBACK;
    if (!allowed.has(reference.kind)) return FailureCode.InvalidReferenceKind;

    if (!reference.money.equals(this.money)) return FailureCode.AmountMismatch;
    return undefined;
  }

  /**
   * Vínculo OPCIONAL de um WIN com a sua BET: só vale se a referência é uma BET PROCESSED no mesmo
   * provider, player, wallet, moeda e rodada. Nunca rejeita o WIN: se não vale, o WIN segue sem vínculo.
   */
  canLinkTo(reference: WagerTransaction): boolean {
    return (
      reference.status === WagerTransactionStatus.Processed &&
      reference.kind === WagerTransactionKind.Bet &&
      this.isInScopeOf(reference)
    );
  }

  private isInScopeOf(reference: WagerTransaction): boolean {
    return (
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency
    );
  }

  private assertNotTerminal(target: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot move ${this._status} to ${target}: ${this._status} is terminal`);
    }
  }
}
