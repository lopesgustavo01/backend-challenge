# Arquitetura e decisões

Este documento explica **como** o sistema garante correção financeira com várias instâncias, **por que** cada decisão foi tomada, o que foi descartado e quais são os limites conhecidos. O guia de uso está no [README](./README.md).

## 1. Visão geral

```
            HTTP POST /wagering/transactions            SQS wager-transactions.fifo
                       │  (Idempotency-Key)                      │  (MessageId = chave do inbox)
                       ▼                                         ▼
                 Controller                              SqsWagerConsumer ── DLQ (motivo no atributo)
                       └────────────┬───────────────────────────┘
                                    ▼
                    ProcessWagerTransactionUseCase      (um único caso de uso para os dois canais)
                                    │  UMA transação SQL
                                    ▼
   inbox ─► lock da wallet (FOR UPDATE) ─► idempotência ─► decide ─► saldo + ledger ─► outbox ─► COMMIT
                                    │
                 ┌──────────────────┴────────────────────┐
                 ▼                                       ▼
        OutboxRelay (qualquer instância)        PENDING_REFERENCE worker (qualquer instância)
        claim+lease → SQS → marca publicada     espera a referência com backoff/TTL
                 ▼
        SQS wager-events.fifo  (ao-menos-uma-vez; consumidor deduplica por eventId)
```

Camadas: **domínio** puro (`Money`, `Wallet`, `WagerTransaction`, sem I/O nem decorators de ORM) → **aplicação** (use cases, portas) → **infraestrutura** (repositórios SQL, SQS, workers) → **HTTP**. Os use cases não conhecem o Nest nem o SQL: recebem portas (`UnitOfWork`, `Clock`, `EventPublisher`…) e são montados por factories em `application.module.ts`.

## 2. Garantia central: nunca saldo negativo, nunca débito/crédito duplicado

A correção **não depende da aplicação**: o banco recusa estados inválidos mesmo se o código tiver um bug.

**Camada 1 — lock por carteira.** Cada operação faz `SELECT … FOR UPDATE` na linha da carteira antes de qualquer outra coisa e só então lê o saldo, decide e grava. Não há lock global: carteiras diferentes processam em paralelo; só a mesma carteira se serializa. A carteira é travada **antes** de qualquer `INSERT` que a referencie (as FKs tomam `FOR KEY SHARE` na linha; duas transações com `KEY SHARE` pedindo `FOR UPDATE` se travam em deadlock). Há ainda uma checagem otimista de `version` no `UPDATE` como cinto de segurança.

**Camada 2 — o schema** (migrations `…190000` e `…083000`):

| Garantia                                                        | Mecanismo                                                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| saldo ≥ 0                                                       | `CHECK (balance >= 0)` em `wallets` e nos saldos do ledger                                                                       |
| uma carteira por (player, moeda)                                | `UNIQUE (player_id, currency)`                                                                                                   |
| idempotência                                                    | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`                                                     |
| ledger imutável                                                 | triggers `BEFORE UPDATE/DELETE/TRUNCATE` recusam qualquer alteração                                                              |
| ledger encadeado e aritmeticamente correto                      | `CHECK` de aritmética + trigger: `balance_before` = `balance_after` do lançamento anterior                                       |
| saldo = ledger                                                  | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`: no `COMMIT`, `wallets.balance` precisa ser igual ao último `balance_after` |
| `version` só sobe 1 quando o saldo muda                         | trigger `wallets_guard`                                                                                                          |
| um lançamento por transação e carteira                          | `UNIQUE (wallet_id, transaction_id)`                                                                                             |
| estados terminais congelados, identidade imutável, sem `DELETE` | trigger em `wager_transactions`                                                                                                  |
| uma reversão por referência                                     | índice único parcial `WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')`                                                |
| player/moeda da transação = da carteira                         | FKs compostas `(wallet_id, player_id)` e `(wallet_id, currency)`                                                                 |
| outbox: conteúdo imutável e publicada não volta                 | trigger `outbox_guard`                                                                                                           |

**Dinheiro:** `decimal.js` no domínio e `NUMERIC(19,2)` no banco; a API aceita **apenas string** (`"80.00"`), com no máximo 2 casas; `number` é rejeitado na borda. Não existe `float` em nenhum caminho de dinheiro.

**Por que as duas camadas:** o lock evita a corrida; o schema garante que, se a corrida acontecesse por um erro futuro, a transação falharia em vez de gravar saldo errado. Verificamos por mutação: removendo o `FOR UPDATE`, 5 testes de concorrência e 3 dos 4 cenários multi-processo quebram.

## 3. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` (HTTP) ou `idempotencyKey` no corpo (SQS; padrão `provider:externalId`). Fica na própria linha da transação com `UNIQUE`, **persistida**, nunca em memória.
- **Mesma chave, mesmo conteúdo** → replay: devolve o resultado original (`idempotentReplay: true`), sem novo efeito, inclusive para rejeições e para `PENDING_REFERENCE` (que passa a devolver o resultado final quando o worker decide).
- **Mesma chave, conteúdo diferente** → `409 IDEMPOTENCY_CONFLICT`. Mesmo `(provider, externalId)` com outra chave também.
- **Hash do conteúdo (`payloadHash`)**: SHA-256 (hex minúsculo) do JSON canônico UTF-8 dos campos de negócio — `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId` —, com chaves ordenadas em todos os níveis, sem espaços e `undefined → null`. O valor entra normalizado (`"25"` ≡ `"25.00"`). Ficam **fora** do hash a chave de idempotência e metadados de transporte (messageId, correlationId).
- **Corrida entre duas requisições iguais:** `INSERT … ON CONFLICT DO NOTHING` **sem alvo** (cobre as duas constraints). Quem perde recebe "não inseri" — não uma exceção que abortaria a transação — e responde como replay.
- **Inbox (SQS):** `PRIMARY KEY (consumer_name, message_id)`, gravado **na mesma transação do efeito**. Entrega repetida da mesma mensagem vira no-op. As duas camadas (inbox por mensagem, chave por transação) são independentes: reenviar a mesma transação como mensagem nova também não duplica.

## 4. Taxonomia de resultados

`failureCode` (estável, legível por máquina):

| Código                        | Status   | Significado                                                                   |
| ----------------------------- | -------- | ----------------------------------------------------------------------------- |
| `INSUFFICIENT_FUNDS`          | REJECTED | BET maior que o saldo                                                         |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | a reversão deixaria saldo negativo                                            |
| `REFERENCE_NOT_FOUND`         | REJECTED | a referência não apareceu até `maxAttempts`/TTL                               |
| `REFERENCE_NOT_PROCESSED`     | REJECTED | a referência existe mas foi rejeitada/falhou (ou nunca foi decidida no prazo) |
| `REFERENCE_MISMATCH`          | REJECTED | outro provedor/player/carteira/moeda/rodada                                   |
| `INVALID_REFERENCE_KIND`      | REJECTED | REFUND de algo que não é BET; ROLLBACK de tipo inválido                       |
| `ALREADY_REVERSED`            | REJECTED | a referência já foi revertida                                                 |
| `AMOUNT_MISMATCH`             | REJECTED | valor diferente do da referência                                              |
| `CURRENCY_MISMATCH`           | REJECTED | moeda diferente da carteira _(ver §5)_                                        |
| `INTERNAL_ERROR`              | FAILED   | erro permanente de infraestrutura (worker esgotou tentativas)                 |

`REJECTED` = regra de negócio, persistida, o provedor não deve reenviar. `FAILED` = infraestrutura. A separação é imposta no domínio (`reject()` recusa códigos de infra, `fail()` recusa os de negócio) e no schema (`wager_tx_failed_is_infra`).

Estados: `PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`, e `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Terminais são congelados pelo banco.

## 5. Decisões de interpretação (e por quê)

1. **Reversão única por referência, qualquer tipo.** A regra do desafio proíbe reverter duas vezes "pelo mesmo tipo de operação". Lida ao pé da letra, uma BET poderia receber um REFUND _e_ um ROLLBACK, creditando o valor duas vezes — violando a invariante de não duplicar créditos. Adotamos a leitura estrita, aplicada no schema (migration `…083000`). `ROLLBACK` _do REFUND_ continua permitido: é outra referência. O teste `REFUND e ROLLBACK pendentes da MESMA BET` prova o resultado (um aplicado, o outro `ALREADY_REVERSED`, crédito único).
2. **Player/moeda divergentes da carteira não são persistidos.** As FKs compostas tornam impossível gravar uma transação inconsistente com a carteira (e é exatamente o que queremos garantir). O erro volta como `422 PLAYER_MISMATCH` / `CURRENCY_MISMATCH` no envelope de erro, sem linha gravada. Consequência: não há replay dessas respostas; o provedor corrige e reenvia.
3. **A referência de um `WIN` é informativa.** Se aponta para uma BET válida, o vínculo é registrado; se não, o WIN **não é bloqueado** (o prêmio é devido). Só REFUND/ROLLBACK exigem referência resolvida.
4. **`LOSS` não move saldo** (pode ter valor zero) e não gera lançamento.
5. **`OPENING`** é interno (crédito de abertura da carteira, gerado por `POST /wallets`); recusado na entrada.

## 6. Mensageria: outbox, inbox, entrega

**Outbox (nada é publicado antes do commit).** Os eventos são gravados na tabela `outbox_messages` **na mesma transação** do efeito financeiro: ou saldo, ledger e eventos confirmam juntos, ou nada (testado injetando falha no outbox, e depois do ledger, e verificando rollback completo). O publicador só enxerga linhas já confirmadas.

**Publicador multi-instância** (`OutboxRelay`):

1. Transação curta: seleciona as vencidas (`FOR UPDATE SKIP LOCKED`, ordem `next_attempt_at, seq`) e as **aluga** empurrando `next_attempt_at` para `agora + OUTBOX_LEASE_MS`; commit.
2. Fora de transação: envia ao SQS (timeout de 10 s; a rede nunca segura conexão ou lock do banco).
3. Transação curta por mensagem: marca `published_at`; ou, se o broker falhou, `attempts+1`, `last_error` e backoff exponencial 1 s, 2 s, 4 s… teto de 5 min.

Cenários cobertos por teste: processo morre após o claim → o aluguel expira e outra instância assume; morre **depois de enviar e antes de marcar** → reenvio, absorvido pela deduplicação do SQS FIFO (`MessageDeduplicationId = eventId`, janela de 5 min) e, depois disso, pelo consumidor (deduplica por `eventId`); broker com 30 % de falhas + 3 instâncias → tudo entregue, sem perda.

> **Achado por mutação:** remover o `SKIP LOCKED` **não** quebra os testes. Quem espera o lock reavalia o `WHERE` com a linha já alugada e a pula, então o que impede o envio duplicado é o **aluguel**; o `SKIP LOCKED` evita que instâncias fiquem esperando umas pelas outras (throughput). Removendo o aluguel, os três testes de concorrência do publicador quebram.

**Consumidor SQS** (`SqsWagerConsumer`):

- **ACK (DeleteMessage) só depois do commit.** Morrer entre o commit e o ACK causa reentrega, que o inbox transforma em no-op.
- Erro **permanente** (JSON/schema inválido, valor com 3 casas, `kind` inválido, conflito de idempotência, player/moeda errados) → copia para a **DLQ** com `failureReason` e só então apaga da origem (se a DLQ falhar, a mensagem não se perde).
- Erro **transitório** (lock, banco, carteira ainda inexistente, inesperado) → não apaga; `ChangeMessageVisibility` com backoff; ao atingir `SQS_MAX_ATTEMPTS` → DLQ (`MAX_ATTEMPTS_EXCEEDED`). O redrive do broker (maxReceiveCount 5) é só a rede de segurança.
- Mensagens do mesmo `MessageGroupId` em ordem, grupos em paralelo. A ordem da fila é só otimização: **a correção vem do lock no banco**, não da ordem.
- `SIGTERM`: para de receber e espera o lote em andamento (inclusive o ACK) antes de fechar o ORM.

**Garantia de entrega do conjunto:** ao-menos-uma-vez na saída (outbox) + efeito exatamente-uma-vez na entrada (inbox + idempotência).

## 7. Reversões que chegam antes da original (`PENDING_REFERENCE`)

Um REFUND/ROLLBACK cuja referência ainda não existe (ou ainda está pendente) é gravado como `PENDING_REFERENCE` (resposta 202) com `next_attempt_at = agora + 2 s`. O worker (em toda instância) reavalia:

- referência apareceu e é válida → `PROCESSED` (lançamento no ledger + eventos); inválida → `REJECTED` por regra de negócio (`AMOUNT_MISMATCH`, `ALREADY_REVERSED`…);
- continua ausente → backoff `min(2 s × 2^tentativas, 60 s)`;
- `maxAttempts` (8) **ou** TTL (10 min) esgotados → `REJECTED / REFERENCE_NOT_FOUND`;
- erro inesperado → a transação inteira é desfeita (saldo intacto), a tentativa conta, e esgotadas as tentativas vira `FAILED / INTERNAL_ERROR` — sem laço infinito.

**Multi-instância sem coordenação externa:** qualquer instância descobre candidatos por leitura sem lock, mas só decide **depois de travar a carteira e reler a transação** (mesma ordem de locks do fluxo de entrada: carteira → transação, sem deadlock). A segunda instância encontra a transação já decidida (ou com a próxima tentativa no futuro) e pula. Mesmo sem essa releitura, o domínio e o trigger de estados terminais impedem a aplicação dupla — o teste exige zero erros logados para provar que a concorrência é resolvida pelo lock, não por exceção. Cadeias invertidas (ROLLBACK do REFUND da BET chegando na ordem inversa) convergem.

## 8. Observabilidade

- **Logs:** uma linha JSON por evento (`level, time, message, …campos`) em stdout/stderr, com `correlationId` (do header `x-correlation-id`, se for um id seguro; senão gerado) em requisições, eventos de domínio e mensagens SQS. Nunca logamos corpo, headers nem valores financeiros — só ids, rotas e códigos. O `500` devolve mensagem genérica; o detalhe vai só para o log.
- **Métricas** (`GET /metrics`, Prometheus): `wager_transactions_total{kind,status,replay,failureCode}` (contado após o commit), `http_requests_total{method,route,status}` (rota **padrão**, cardinalidade limitada), `sqs_messages_total{outcome}`, `outbox_published_total`, `outbox_publish_failures_total`, `pending_reference_total{outcome}`, `wallet_reconciliations_total`, `wallet_reconciliation_divergences_total`; e gauges lidos do banco, válidos para qualquer instância: `outbox_pending_messages`, `outbox_failing_messages`, `outbox_lag_seconds`, `pending_reference_transactions`, `pending_reference_oldest_age_seconds`.
- **Reconciliação** (`POST /wallets/:id/reconciliation`): lê o saldo gravado e a soma do ledger **num único statement** (mesmo snapshot, sem falso positivo sob carga). É **somente leitura**: divergência é logada (`error`), contada e sinalizada na resposta (`consistent:false`, `difference`), nunca corrigida em silêncio.
- **Health:** `/health/live` e `/health/ready` (Postgres e SQS).

## 9. HTTP

Mapa de status único para todos os endpoints (README). Princípios: rejeição de negócio **persistida** volta como resultado (`422` com `status:REJECTED` e `failureCode`, replay idempotente); erro que não vira transação volta no envelope `{error:{code,message}}`; `503 + Retry-After` só para falha transitória segura de repetir. O extrato usa **cursor opaco** (base64url de `{v, walletId, seq}`) sobre `seq` (identity bigint): como o lançamento é inserido com a carteira travada, `seq` cresce na ordem do commit dentro de uma carteira e `seq > cursor` nunca pula nem repete linha, mesmo com lançamentos novos entre páginas.

## 10. Persistência: MikroORM com SQL explícito

O MikroORM é usado como gerenciador de **conexões, transações e migrations** (`em.fork().transactional()`, `lock_timeout` por transação). Os repositórios usam SQL explícito (`em.execute`), sem entidades decoradas: o domínio fica sem acoplamento ao ORM e as garantias de concorrência (`FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT`, CTE de claim) ficam visíveis e testáveis, em vez de escondidas num unit-of-work implícito. **Prisma não é usado.** O Bun não emite `design:paramtypes`, então toda injeção do Nest usa `@Inject` explícito.

## 11. Estratégia de testes

Banco e fila **reais** em todos os níveis (nenhum mock os substitui). Cada arquivo cria um banco descartável; "instâncias" são ORMs/pools independentes; o e2e usa **processos reais** com `SIGKILL`. Os testes de schema usam também PGlite (Postgres em WASM) para verificar as constraints rapidamente, além do Postgres real. Cada teste de concorrência foi validado por **mutação** (remover lock, aluguel, releitura sob lock, ACK pós-commit, ordem DLQ→apagar, inbox, backoff, teto de tentativas) para provar que ele detecta a falha que diz detectar. Invariante verificada ao fim de praticamente todo cenário: `wallet.balance == soma do ledger`, cadeia de saldos sem buracos, saldo ≥ 0, nenhum lançamento duplicado por transação.

## 12. Limites conhecidos e trade-offs

- **Ordem dos eventos por carteira é "melhor esforço"** no outbox (um retry pode ultrapassar outro evento). Eventos carregam `occurredAt`; o consumidor não deve depender de ordem. Ordem estrita exigiria enviar só o evento mais antigo de cada agregado por vez (head-of-line blocking).
- **Relógio:** `next_attempt_at`/aluguel usam o relógio da aplicação; defasagem grande entre instâncias só altera quando uma retentativa acontece, nunca a correção (o aluguel é conservador e o envio é idempotente).
- **Retenção:** não há job de limpeza para `inbox_messages`, `outbox_messages` publicadas e para `wager_transactions`/ledger (que por regra são permanentes). Em produção, inbox/outbox precisariam de política de retenção/particionamento.
- **Reprocessamento da DLQ é manual** (sem endpoint/worker de redrive).
- **Sem autenticação/autorização** na API e em `/metrics` (fora do escopo); em produção, restringir por rede/gateway. As métricas de contador são por processo (cada instância é raspada separadamente).
- **Carteira muito quente** serializa por definição (um lock por carteira); `lock_timeout` (5 s) devolve `503` em vez de acumular conexões presas.
- A morte exatamente entre commit e ACK nos **processos reais** depende do instante do `SIGKILL`; o caso exato é coberto nos testes determinísticos do consumidor (cliente SQS que falha no `DeleteMessage`).
- Os testes de SQS dependem de um endpoint SQS compatível: LocalStack no `docker-compose` (o desenvolvimento aqui foi validado também contra o `moto`, que implementa FIFO e deduplicação).
