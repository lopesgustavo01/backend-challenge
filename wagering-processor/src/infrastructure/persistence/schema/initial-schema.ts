/**
 * Schema inicial: fonte única do DDL. A migration do MikroORM e os testes de integração
 * importam daqui. Nenhum statement usa "?" (knex.raw interpretaria como binding).
 *
 * Garantias aplicadas NO BANCO (seção 5.9 do desafio):
 *  - unicidade: wallet por (player, moeda); idempotency key; (provider, external id);
 *    uma reversão PROCESSED por (referência, tipo); um lançamento por (wallet, transação)
 *  - não-negatividade: wallets.balance e saldos do ledger >= 0
 *  - imutabilidade: ledger append-only; transação terminal congelada; identidade imutável
 *  - consistência: saldo materializado == último balance_after do ledger (verificado no COMMIT)
 *    e encadeamento balance_before == balance_after anterior
 *
 * Convenções: ids gerados pela aplicação (UUID v7); datas em timestamptz; dinheiro em numeric(19,2).
 * OPENING usa provider_id = 'system' e external_transaction_id = idempotency_key = 'opening:<walletId>'.
 */

export const up: string[] = [
  // ───────────────────────────── wallets ─────────────────────────────
  `CREATE TABLE wallets (
    id          uuid PRIMARY KEY,
    player_id   text NOT NULL,
    currency    text NOT NULL,
    balance     numeric(19,2) NOT NULL,
    version     integer NOT NULL DEFAULT 1,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,
    CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT wallets_version_positive CHECK (version >= 1),
    CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wallets_player_not_empty CHECK (player_id <> ''),
    CONSTRAINT wallets_player_currency_key UNIQUE (player_id, currency),
    CONSTRAINT wallets_id_currency_key UNIQUE (id, currency),
    CONSTRAINT wallets_id_player_key UNIQUE (id, player_id)
  )`,
  `COMMENT ON TABLE wallets IS 'Saldo materializado. Concorrência: SELECT ... FOR UPDATE por linha (nunca lock global).'`,

  // AFTER (não BEFORE) de propósito: os CHECKs (ex.: saldo >= 0) disparam primeiro e dão a causa real.
  // Identidade imutável; version sobe exatamente 1 quando (e só quando) o saldo muda.
  `CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
       OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'wallets identity columns are immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.balance <> OLD.balance THEN
      IF NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'wallets.version must increase by 1 when balance changes' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    ELSIF NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'wallets.version must not change when balance is unchanged' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
  END $$`,
  `CREATE TRIGGER wallets_guard_trg AFTER UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION wallets_guard()`,

  // ───────────────────────── wager_transactions ─────────────────────────
  `CREATE TABLE wager_transactions (
    id                                uuid PRIMARY KEY,
    provider_id                       text NOT NULL,
    external_transaction_id           text NOT NULL,
    idempotency_key                   text NOT NULL,
    payload_hash                      text NOT NULL,
    wallet_id                         uuid NOT NULL,
    player_id                         text NOT NULL,
    round_id                          text NOT NULL,
    game_id                           text NOT NULL,
    kind                              text NOT NULL,
    amount                            numeric(19,2) NOT NULL,
    currency                          text NOT NULL,
    reference_external_transaction_id text,
    reference_transaction_id          uuid REFERENCES wager_transactions (id),
    status                            text NOT NULL DEFAULT 'PENDING',
    failure_code                      text,
    balance_after                     numeric(19,2),
    reference_attempts                integer NOT NULL DEFAULT 0,
    next_attempt_at                   timestamptz,
    created_at                        timestamptz NOT NULL,
    processed_at                      timestamptz,

    CONSTRAINT wager_tx_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
    CONSTRAINT wager_tx_wallet_player_fk FOREIGN KEY (wallet_id, player_id) REFERENCES wallets (id, player_id),
    CONSTRAINT wager_tx_idempotency_key_key UNIQUE (idempotency_key),
    CONSTRAINT wager_tx_provider_external_key UNIQUE (provider_id, external_transaction_id),
    CONSTRAINT wager_tx_id_wallet_key UNIQUE (id, wallet_id),

    CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
    CONSTRAINT wager_tx_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wager_tx_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT wager_tx_amount_valid CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
    CONSTRAINT wager_tx_attempts_valid CHECK (reference_attempts >= 0),
    CONSTRAINT wager_tx_balance_after_valid CHECK (balance_after IS NULL OR balance_after >= 0),
    CONSTRAINT wager_tx_keys_not_empty CHECK (idempotency_key <> '' AND external_transaction_id <> '' AND provider_id <> ''),
    CONSTRAINT wager_tx_reference_by_kind CHECK (
      CASE
        WHEN kind IN ('REFUND','ROLLBACK') THEN reference_external_transaction_id IS NOT NULL AND reference_external_transaction_id <> ''
        WHEN kind IN ('BET','OPENING') THEN reference_external_transaction_id IS NULL
        ELSE true
      END
    ),
    CONSTRAINT wager_tx_reversal_has_reference CHECK (
      NOT (kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED' AND reference_transaction_id IS NULL)
    ),
    CONSTRAINT wager_tx_failure_code_by_status CHECK (
      (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
    ),
    CONSTRAINT wager_tx_failure_code_valid CHECK (
      failure_code IS NULL OR failure_code IN (
        'INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','REFERENCE_NOT_FOUND','REFERENCE_NOT_PROCESSED',
        'REFERENCE_MISMATCH','INVALID_REFERENCE_KIND','ALREADY_REVERSED','AMOUNT_MISMATCH',
        'CURRENCY_MISMATCH','INTERNAL_ERROR')
    ),
    CONSTRAINT wager_tx_failed_is_infra CHECK (
      (status = 'FAILED') = COALESCE(failure_code = 'INTERNAL_ERROR', false)
    ),
    CONSTRAINT wager_tx_processed_at_by_status CHECK (
      (status = 'PROCESSED') = (processed_at IS NOT NULL)
    )
  )`,
  // uma referência só é revertida uma vez por tipo (regra 4); tentativas REJECTED não consomem a vaga
  `CREATE UNIQUE INDEX wager_tx_one_reversal_per_kind
     ON wager_transactions (reference_transaction_id, kind)
     WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`,
  // varredura do worker de PENDING_REFERENCE
  `CREATE INDEX wager_tx_pending_reference_idx
     ON wager_transactions (next_attempt_at)
     WHERE status = 'PENDING_REFERENCE'`,
  `CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at)`,

  // terminais congelados; identidade imutável; nunca volta para PENDING; sem DELETE
  `CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'wager_transactions is append-only (DELETE not allowed)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
      RAISE EXCEPTION 'wager transaction in terminal status % cannot be updated', OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.id <> OLD.id OR NEW.provider_id <> OLD.provider_id
       OR NEW.external_transaction_id <> OLD.external_transaction_id
       OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
       OR NEW.wallet_id <> OLD.wallet_id OR NEW.player_id <> OLD.player_id
       OR NEW.round_id <> OLD.round_id OR NEW.game_id <> OLD.game_id
       OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
       OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'wager_transactions identity columns are immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'wager transaction status cannot go back to PENDING' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE TRIGGER wager_transactions_guard_trg BEFORE UPDATE OR DELETE ON wager_transactions
    FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`,

  // ──────────────────────── wallet_ledger_entries ────────────────────────
  `CREATE TABLE wallet_ledger_entries (
    id             uuid PRIMARY KEY,
    seq            bigint GENERATED ALWAYS AS IDENTITY,
    wallet_id      uuid NOT NULL,
    transaction_id uuid NOT NULL,
    direction      text NOT NULL,
    amount         numeric(19,2) NOT NULL,
    currency       text NOT NULL,
    balance_before numeric(19,2) NOT NULL,
    balance_after  numeric(19,2) NOT NULL,
    created_at     timestamptz NOT NULL,

    CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
    CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
    CONSTRAINT ledger_seq_key UNIQUE (seq),
    CONSTRAINT ledger_wallet_transaction_key UNIQUE (wallet_id, transaction_id),
    CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
    CONSTRAINT ledger_amount_positive CHECK (amount > 0),
    CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
    CONSTRAINT ledger_arithmetic CHECK (
      (direction = 'CREDIT' AND balance_before + amount = balance_after)
      OR (direction = 'DEBIT' AND balance_before - amount = balance_after)
    )
  )`,
  `CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq)`,
  `COMMENT ON COLUMN wallet_ledger_entries.seq IS 'Ordenação estável e chave do cursor de paginação; atribuída sob o lock da wallet.'`,

  `CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'wallet_ledger_entries is append-only (% not allowed)', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END $$`,
  `CREATE TRIGGER ledger_append_only_row_trg BEFORE UPDATE OR DELETE ON wallet_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_append_only()`,
  `CREATE TRIGGER ledger_append_only_truncate_trg BEFORE TRUNCATE ON wallet_ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only()`,

  // encadeamento: balance_before precisa ser o balance_after do lançamento anterior da wallet (0 se não há)
  // Correto porque a aplicação serializa por wallet (FOR UPDATE) antes de inserir.
  `CREATE FUNCTION ledger_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    prev numeric(19,2);
  BEGIN
    SELECT balance_after INTO prev FROM wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
    IF NOT FOUND THEN prev := 0; END IF;
    IF NEW.balance_before <> prev THEN
      RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % but previous balance_after is %',
        NEW.wallet_id, NEW.balance_before, prev USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE TRIGGER ledger_chain_guard_trg BEFORE INSERT ON wallet_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_chain_guard()`,

  // saldo materializado == último balance_after do ledger, verificado no COMMIT por qualquer um dos lados
  `CREATE FUNCTION wallets_assert_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    actual   numeric(19,2);
    expected numeric(19,2);
  BEGIN
    SELECT balance INTO actual FROM wallets WHERE id = NEW.id;
    SELECT balance_after INTO expected FROM wallet_ledger_entries
      WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
    IF NOT FOUND THEN expected := 0; END IF;
    IF actual <> expected THEN
      RAISE EXCEPTION 'wallet % balance % does not match ledger %', NEW.id, actual, expected
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
  END $$`,
  `CREATE CONSTRAINT TRIGGER wallets_ledger_consistency_trg AFTER INSERT OR UPDATE OF balance ON wallets
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallets_assert_ledger_consistency()`,

  `CREATE FUNCTION ledger_assert_wallet_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    actual   numeric(19,2);
    expected numeric(19,2);
  BEGIN
    SELECT balance INTO actual FROM wallets WHERE id = NEW.wallet_id;
    SELECT balance_after INTO expected FROM wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
    IF actual <> expected THEN
      RAISE EXCEPTION 'wallet % balance % does not match ledger %', NEW.wallet_id, actual, expected
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
  END $$`,
  `CREATE CONSTRAINT TRIGGER ledger_wallet_consistency_trg AFTER INSERT ON wallet_ledger_entries
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_wallet_consistency()`,

  // ───────────────────────────── inbox ─────────────────────────────
  `CREATE TABLE inbox_messages (
    consumer_name text NOT NULL,
    message_id    text NOT NULL,
    payload_hash  text NOT NULL,
    received_at   timestamptz NOT NULL,
    processed_at  timestamptz,
    CONSTRAINT inbox_pkey PRIMARY KEY (consumer_name, message_id),
    CONSTRAINT inbox_ids_not_empty CHECK (consumer_name <> '' AND message_id <> ''),
    CONSTRAINT inbox_hash_format CHECK (payload_hash ~ '^[0-9a-f]{64}$')
  )`,

  // ───────────────────────────── outbox ─────────────────────────────
  // id = eventId. next_attempt_at nasce preenchido: o publisher só filtra e ordena.
  `CREATE TABLE outbox_messages (
    id              uuid PRIMARY KEY,
    seq             bigint GENERATED ALWAYS AS IDENTITY,
    aggregate_id    text NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL,
    occurred_at     timestamptz NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    last_error      text,
    CONSTRAINT outbox_seq_key UNIQUE (seq),
    CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0),
    CONSTRAINT outbox_event_type_not_empty CHECK (event_type <> '' AND aggregate_id <> '')
  )`,
  `CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at, seq) WHERE published_at IS NULL`,

  `CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.id <> OLD.id OR NEW.aggregate_id <> OLD.aggregate_id OR NEW.event_type <> OLD.event_type
       OR NEW.payload <> OLD.payload OR NEW.occurred_at <> OLD.occurred_at OR NEW.seq <> OLD.seq THEN
      RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION 'outbox message already published' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END $$`,
  `CREATE TRIGGER outbox_guard_trg BEFORE UPDATE ON outbox_messages
    FOR EACH ROW EXECUTE FUNCTION outbox_guard()`,
];

/** Reversão exata de `up` (tabelas primeiro, que levam seus triggers; depois as funções). */
export const down: string[] = [
  `DROP TABLE outbox_messages`,
  `DROP TABLE inbox_messages`,
  `DROP TABLE wallet_ledger_entries`,
  `DROP TABLE wager_transactions`,
  `DROP TABLE wallets`,
  `DROP FUNCTION outbox_guard()`,
  `DROP FUNCTION ledger_assert_wallet_consistency()`,
  `DROP FUNCTION wallets_assert_ledger_consistency()`,
  `DROP FUNCTION ledger_chain_guard()`,
  `DROP FUNCTION ledger_append_only()`,
  `DROP FUNCTION wager_transactions_guard()`,
  `DROP FUNCTION wallets_guard()`,
];
