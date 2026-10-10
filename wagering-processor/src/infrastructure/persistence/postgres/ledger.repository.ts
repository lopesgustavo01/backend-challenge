import { Money } from "@/shared/domain/money";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "@/modules/wallet/domain/wallet-ledger-entry";
import {
  LedgerPageItem,
  LedgerReconciliation,
  LedgerRepository,
} from "@/modules/wagering/application/ports";
import { Executor, iso, query, toIso } from "./sql";

interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string;
}

const COLUMNS = `seq::text as seq, id, wallet_id, transaction_id, direction, amount::text as amount, currency,
  balance_before::text as balance_before, balance_after::text as balance_after, ${iso("created_at")}`;

function toItem(row: LedgerRow): LedgerPageItem {
  const money = (amount: string) =>
    Money.from({ amount, currency: row.currency });
  return {
    seq: row.seq,
    entry: WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.wallet_id,
      transactionId: row.transaction_id,
      direction: row.direction as LedgerDirection,
      money: money(row.amount),
      balanceBefore: money(row.balance_before),
      balanceAfter: money(row.balance_after),
      createdAt: new Date(row.created_at),
    }),
  };
}

/** `Money.from` só aceita valores não negativos (contrato de entrada); a soma do ledger pode ser negativa se houver corrupção. */
function signedMoney(text: string, currency: string): Money {
  return text.startsWith("-")
    ? Money.zero(currency).subtract(
        Money.from({ amount: text.slice(1), currency }),
      )
    : Money.from({ amount: text, currency });
}

export class PostgresLedgerRepository implements LedgerRepository {
  constructor(private readonly em: Executor) {}

  /** Só INSERT: UPDATE/DELETE/TRUNCATE são barrados por trigger no schema. `seq` é gerado pelo banco. */
  async append(entry: WalletLedgerEntry): Promise<void> {
    await query(
      this.em,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toJSON().amount,
        entry.money.currency,
        entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount,
        toIso(entry.createdAt),
      ],
    );
  }

  /** Usa o índice (wallet_id, seq): keyset pagination, custo constante por página. */
  async listByWallet(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPageItem[]> {
    const after = afterSeq ?? null;
    const rows = await query<LedgerRow>(
      this.em,
      `select ${COLUMNS} from wallet_ledger_entries
        where wallet_id = ? and (?::bigint is null or seq > ?::bigint)
        order by seq asc
        limit ?`,
      [walletId, after, after, limit],
    );
    return rows.map(toItem);
  }

  /**
   * Um único statement: o saldo da wallet e a soma do ledger vêm do mesmo snapshot do MVCC.
   * Com duas leituras separadas, um commit entre elas geraria uma divergência que não existe.
   */
  async reconcile(walletId: string): Promise<LedgerReconciliation | undefined> {
    const [row] = await query<{
      currency: string;
      stored: string;
      calculated: string;
      entries: number;
    }>(
      this.em,
      `select w.currency,
              w.balance::text as stored,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      storedBalance: Money.from({ amount: row.stored, currency: row.currency }),
      calculatedBalance: signedMoney(row.calculated, row.currency),
      checkedEntries: Number(row.entries),
    };
  }
}
