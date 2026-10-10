# Wagering Processor

Processador distribuído de transações de apostas: recebe `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por **HTTP** e por **SQS**, mantém o saldo de cada carteira correto sob concorrência (várias instâncias), com **ledger imutável**, **idempotência persistida**, **outbox/inbox** e reprocessamento de reversões que chegam antes da transação original.

Stack: Bun · TypeScript estrito · NestJS · PostgreSQL 16 · AWS SQS (LocalStack) · MikroORM 7 (conexão/transações; SQL explícito) · Docker Compose.
As decisões de projeto, trade-offs e limites conhecidos estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Como rodar

Pré-requisitos: Bun 1.x e Docker (Docker Desktop com backend WSL2 no Windows).

```bash
cp .env.example .env          # Windows: Copy-Item .env.example .env
bun install
bun run infra:up              # Postgres + LocalStack (filas SQS criadas automaticamente)
bun run migrate:up            # schema do banco
bun run dev                   # API + consumidor SQS + publicador do outbox + worker de PENDING_REFERENCE
```

Verificações: `GET /health/live`, `GET /health/ready` (Postgres e SQS), `GET /metrics`.

Mais instâncias (mesmo banco, mesma fila) — a coordenação é feita pelos locks do banco, não por configuração:

```bash
PORT=3001 bun run start       # outro terminal; Windows: $env:PORT=3001; bun run start
```

> Se as filas não forem criadas, veja `docker compose logs localstack` e confirme que `docker/localstack/init/01-sqs.sh` está com final de linha LF. Após atualizar o script de init, recrie o container: `docker compose up -d --force-recreate localstack`.

### Variáveis de ambiente

| Variável                                                                       | Padrão                | Função                                                                        |
| ------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------- |
| `PORT`                                                                         | 3000                  | porta HTTP                                                                    |
| `DATABASE_URL`                                                                 | —                     | Postgres                                                                      |
| `AWS_REGION`, `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | —                     | SQS (LocalStack)                                                              |
| `SQS_QUEUE_URL` / `SQS_DLQ_URL`                                                | —                     | fila de **entrada** (FIFO) e a sua DLQ                                        |
| `SQS_EVENTS_QUEUE_URL`                                                         | `…/wager-events.fifo` | fila de **saída** (eventos do outbox)                                         |
| `SQS_CONSUMER_ENABLED`                                                         | true                  | liga o consumidor                                                             |
| `SQS_WAIT_TIME_SECONDS`                                                        | 20                    | long polling                                                                  |
| `SQS_MAX_ATTEMPTS`                                                             | 5                     | entregas antes de a mensagem ir para a DLQ                                    |
| `SQS_IDLE_DELAY_MS`                                                            | 0                     | pausa após poll vazio (só para brokers que respondem na hora)                 |
| `OUTBOX_PUBLISHER_ENABLED`                                                     | true                  | liga o publicador                                                             |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE`                                | 500 / 50              | ritmo do publicador                                                           |
| `OUTBOX_LEASE_MS`                                                              | 30000                 | quanto tempo uma instância "é dona" de um lote (deve exceder um envio ao SQS) |
| `PENDING_REFERENCE_WORKER_ENABLED`                                             | true                  | liga o worker de reversões pendentes                                          |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` / `…_BATCH_SIZE`                          | 1000 / 20             | ritmo do worker                                                               |

## API

Todas as respostas de erro seguem `{ "error": { "code", "message" } }`. Dinheiro é sempre **string decimal com 2 casas** (`"80.00"`); número JSON é rejeitado.

| Método e rota                                                             | Descrição                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /wallets`                                                           | cria carteira `{ playerId, initialBalance:{amount,currency} }` → 201 + `Location` |
| `GET /wallets/:walletId`                                                  | carteira e saldo                                                                  |
| `GET /wallets/:walletId/ledger?limit=&cursor=`                            | extrato paginado por cursor opaco (limite 1–200, padrão 50)                       |
| `POST /wallets/:walletId/reconciliation`                                  | compara saldo gravado × soma do ledger (somente leitura)                          |
| `POST /wagering/transactions`                                             | processa uma transação. **Header `Idempotency-Key` obrigatório**                  |
| `GET /wagering/transactions/:id`                                          | transação por id                                                                  |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor                                                     |
| `GET /metrics`                                                            | métricas Prometheus                                                               |

### Status HTTP de `POST /wagering/transactions`

| Status                                                 | Quando                                                            | O que o provedor faz                          |
| ------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------- |
| 200                                                    | processada (ou replay do mesmo pedido)                            | segue                                         |
| 202                                                    | `PENDING_REFERENCE`: reversão aguardando a transação referenciada | não reenviar; consultar depois                |
| 422 `status:REJECTED` + `failureCode`                  | regra de negócio (ver tabela no ARCHITECTURE)                     | não reenviar: o resultado é o mesmo           |
| 422 `error.code` `PLAYER_MISMATCH`/`CURRENCY_MISMATCH` | player/moeda não pertencem à carteira (nada é gravado)            | corrigir                                      |
| 400                                                    | payload ou header inválido                                        | corrigir e reenviar                           |
| 404                                                    | carteira inexistente                                              | —                                             |
| 409                                                    | mesma `Idempotency-Key` com conteúdo diferente                    | não reenviar                                  |
| 503 + `Retry-After`                                    | falha transitória (lock, banco)                                   | reenviar a **mesma** requisição (idempotente) |
| 500                                                    | erro inesperado (mensagem genérica; detalhe só no log)            | —                                             |

### Exemplo

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'idempotency-key: prov-a:e1' \
  -d '{"providerId":"prov-a","externalTransactionId":"e1","playerId":"p1","walletId":"<ID>",
       "roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"30.00","currency":"BRL"}}'
# → 200 {"status":"PROCESSED","balance":{"amount":"70.00",…},"idempotentReplay":false}
# repetir o mesmo comando → 200 com "idempotentReplay":true e o mesmo transactionId
```

(PowerShell: use `curl.exe` e escape as aspas do JSON com `\"`.)

### Entrada por SQS

Mensagem na fila `SQS_QUEUE_URL` (FIFO; use `MessageGroupId`, p.ex. o `walletId`): corpo JSON com os **mesmos campos** do POST, mais `idempotencyKey` opcional (padrão `providerId:externalTransactionId`). Atributo opcional `correlationId`.
Resultado: processada ou rejeitada por regra de negócio → mensagem apagada; erro permanente (JSON/valor inválido, conflito de idempotência, player/moeda errados) → **DLQ** com o motivo no atributo `failureReason`; erro transitório → volta com backoff e, após `SQS_MAX_ATTEMPTS`, vai para a DLQ.

### Eventos de saída

O outbox publica em `SQS_EVENTS_QUEUE_URL` (FIFO, `MessageGroupId` = carteira, `MessageDeduplicationId` = `eventId`): `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`. Entrega **ao-menos-uma-vez**; consumidores deduplicam por `eventId`.

## Testes

Todos usam **Postgres e SQS reais** (nenhum mock substitui banco ou fila). Cada arquivo cria um banco descartável no servidor do `DATABASE_URL` e o derruba no fim; as filas também são descartáveis.

```bash
bun run infra:up
bun run typecheck
bun test                                   # tudo (~326 testes)
bun test test/unit                         # domínio puro, sem I/O
bun test test/integration                  # schema, use cases, HTTP, outbox, consumidor, worker
bun test test/concurrency                  # paralelismo real, várias "instâncias" (ORMs/pools) no mesmo banco
bun test test/e2e                          # 3 PROCESSOS reais + SIGKILL no meio da carga (~1–2 min)
```

O que cada camada prova (resumo; detalhes no ARCHITECTURE.md):

- **unit** — `Money` (decimal, sem float), transições de estado, regras de referência, cursor, mapa de erros.
- **integration** — o schema recusa o que o código não deveria fazer (`CHECK balance >= 0`, ledger append-only, estados terminais congelados, uma reversão por referência); use cases; API HTTP completa; outbox só publica após o commit; consumidor SQS (ACK pós-commit, DLQ, retry); worker de `PENDING_REFERENCE`.
- **concurrency** — carteira de 100,00 com dois débitos de 80,00 simultâneos (um passa, um é rejeitado, saldo 20,00); carteira "quente"; mesma chave 50× em paralelo; mesma mensagem SQS 20×; 20 reversões da mesma BET; publicadores e workers concorrentes sem duplicar trabalho.
- **e2e** — 3 processos `bun src/main.ts` disputando banco e fila; um é morto com `SIGKILL` no meio da carga e volta; no fim, saldo = soma do ledger em toda carteira, nenhum efeito duplicado ou perdido, todo evento entregue uma vez.

Os testes de concorrência e de e2e foram validados também por **mutação** (remover `FOR UPDATE`, o aluguel do outbox, a releitura sob lock, o ACK pós-commit etc. quebra testes), para garantir que não passam por acaso.

## Scripts

`dev` · `start` · `typecheck` · `test` · `infra:up|down|reset` · `migrate:up|down`

## Estrutura

```
src/
  modules/
    wallet/      domain (Wallet, ledger entry), application (criar, consultar, extrato, reconciliar)
    wagering/    domain (transação, FailureCode, eventos), application (use cases, settlement, outbox relay, worker)
  shared/        Money, mensageria (inbox/outbox/eventos), observabilidade
  infrastructure/
    persistence/ schema + migrations, repositórios (SQL explícito), unit of work
    messaging/   SQS: consumidor, publicador, módulo
    workers/     laço de polling + worker de PENDING_REFERENCE
  http/          controllers, filtro de erros, correlationId, log/metrics de requisição
test/            unit · integration · concurrency · e2e
```
