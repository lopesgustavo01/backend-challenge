import { Money } from "@/shared/domain/money";
import { Wallet } from "@/modules/wallet/domain/wallet";
import { TransientProcessingError } from "@/modules/wagering/application/errors";
import { WalletRepository } from "@/modules/wagering/application/ports";
import { Executor, iso, query, toIso } from "./sql";

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, player_id, currency, balance::text as balance, version, ${iso("created_at")}, ${iso("updated_at")}`;

function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: Number(row.version),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}

export class PostgresWalletRepository implements WalletRepository {
  constructor(private readonly em: Executor) {}

  /** O lock que serializa a wallet. Tem de ser o PRIMEIRO acesso à wallet na transação. */
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const [row] = await query<WalletRow>(
      this.em,
      `select ${COLUMNS} from wallets where id = ? for update`,
      [id],
    );
    return row ? toWallet(row) : undefined;
  }

  async find(id: string): Promise<Wallet | undefined> {
    const [row] = await query<WalletRow>(
      this.em,
      `select ${COLUMNS} from wallets where id = ?`,
      [id],
    );
    return row ? toWallet(row) : undefined;
  }

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const rows = await query<{ id: string }>(
      this.em,
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toJSON().amount,
        wallet.version,
        toIso(wallet.createdAt),
        toIso(wallet.updatedAt),
      ],
    );
    return rows.length === 1;
  }

  /**
   * Optimistic check por cima do lock pessimista: se a versão não é a esperada, algo furou o protocolo
   * (ex.: código que não travou antes). Falha fechada em vez de sobrescrever saldo.
   */
  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await query<{ id: string }>(
      this.em,
      `update wallets set balance = ?, version = ?, updated_at = ?
       where id = ? and version = ?
       returning id`,
      [
        wallet.balance.toJSON().amount,
        wallet.version,
        toIso(wallet.updatedAt),
        wallet.id,
        expectedVersion,
      ],
    );
    if (rows.length !== 1) {
      throw new TransientProcessingError(
        `Wallet ${wallet.id} was modified concurrently (expected version ${expectedVersion})`,
      );
    }
  }
}
