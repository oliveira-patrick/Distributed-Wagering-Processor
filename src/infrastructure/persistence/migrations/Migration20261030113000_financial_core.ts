import { Migration } from '@mikro-orm/migrations';

/*
  Schema do núcleo financeiro: wallets, ledger, transações, inbox e outbox.

  A régua desta migration é uma só: unicidade, imutabilidade e
  não-negatividade precisam viver **no schema**, não só no código da
  aplicação. Garantia que mora apenas no domínio protege o caminho
  que passa pelo domínio; aqui a proteção vale também para o `psql` de
  madrugada, para o script de correção escrito às pressas e para a segunda
  instância que subiu com uma versão diferente do código.

  Cada valor monetário é `numeric(20, 2)`: decimal exato, 18 dígitos
  inteiros e 2 decimais, espelhando `MAX_INTEGER_DIGITS` e `MONEY_SCALE` do
  domínio. Nunca `double precision`: dinheiro não se guarda em binário
  flutuante.

  **Uma moeda por linha**, não uma por valor monetário. Numa linha deste
  schema todos os valores compartilham a moeda por invariante — um
  lançamento move um valor numa moeda, com saldo antes e depois na mesma
  moeda, e isso é definição, não escopo. Com uma coluna por valor existiria
  linha representável com moedas internas divergentes, estado que o domínio
  proíbe e que exigiria `check` extra para excluir; com uma por linha ele é
  irrepresentável, e a `foreign key` composta para `wallets (id, currency)`
  ainda faz o banco garantir que a moeda do lançamento é a da wallet. Ver
  ADR-006.

  `status`, `kind` e `direction` são `text` com `check`, e não `enum` do
  PostgreSQL: `alter type ... add value` não convive bem com migration
  transacional, e o domínio já os representa como union de literais. Os três
  aparecem no schema porque as próprias constraints dependem deles — a conta
  do lançamento é escrita em termos de `DEBIT` e `CREDIT`. `failure_code`
  não aparece: ele não governa constraint nenhuma, a taxonomia é explicitamente
  do candidato e cresce, e o tipo em TypeScript já impede o erro de digitação.
*/
export class Migration20261030113000_financial_core extends Migration {
  override name = 'Migration20261030113000_financial_core';

  override up(): void {
    this.addSql(`
      create table "wallets" (
        "id"             uuid          not null,
        "player_id"      text          not null,
        "currency"       char(3)       not null,
        "balance_amount" numeric(20,2) not null,
        "version"        int           not null,
        "created_at"     timestamptz   not null,
        "updated_at"     timestamptz   not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_currency_iso"
          check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_balance_not_negative"
          check ("balance_amount" >= 0),
        constraint "wallets_version_positive"
          check ("version" >= 1),
        constraint "wallets_player_currency_unique"
          unique ("player_id", "currency"),
        constraint "wallets_id_currency_unique"
          unique ("id", "currency")
      )
    `);

    /*
      Saldo negativo é falha eliminatória, e esta é a última linha de defesa:
      vale mesmo para quem escrever `update` à mão.
    */
    this.addSql(`
      comment on constraint "wallets_balance_not_negative" on "wallets" is
        'Restrição 9: não-negatividade do saldo garantida pelo schema.'
    `);
    
    /*
      Alvo da foreign key composta das duas tabelas que referenciam a
      wallet. Redundante para unicidade — "id" já é chave primária —, e é o
      que permite ao banco recusar linha cuja moeda divirja da wallet.
    */
    this.addSql(`
      comment on constraint "wallets_id_currency_unique" on "wallets" is
        'Alvo da foreign key composta que propaga a moeda da wallet.'
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id"                                uuid          not null,
        "provider_id"                       text          not null,
        "external_transaction_id"           text          not null,
        "idempotency_key"                   text          not null,
        "payload_hash"                      char(64)      not null,
        "wallet_id"                         uuid          not null,
        "player_id"                         text          not null,
        "round_id"                          text          not null,
        "game_id"                           text          not null,
        "kind"                              text          not null,
        "currency"                          char(3)       not null,
        "money_amount"                      numeric(20,2) not null,
        "reference_external_transaction_id" text,
        "status"                            text          not null,
        "reference_transaction_id"          uuid,
        "failure_code"                      text,
        "processed_at"                      timestamptz,
        "observed_balance_amount"           numeric(20,2),
        "reference_attempts"                int           not null default 0,
        "next_reference_attempt_at"         timestamptz,
        "created_at"                        timestamptz   not null,

        constraint "wager_transactions_pkey" primary key ("id"),

        constraint "wager_transactions_kind_known"
          check ("kind" in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint "wager_transactions_status_known"
          check ("status" in
            ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint "wager_transactions_currency_iso"
          check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_payload_hash_sha256"
          check ("payload_hash" ~ '^[0-9a-f]{64}$'),

        constraint "wager_transactions_amount_positive"
          check ("money_amount" > 0),
        constraint "wager_transactions_observed_balance_not_negative"
          check ("observed_balance_amount" >= 0),
        constraint "wager_transactions_attempts_not_negative"
          check ("reference_attempts" >= 0),

        constraint "wager_transactions_idempotency_key_unique"
          unique ("idempotency_key"),
        constraint "wager_transactions_provider_external_unique"
          unique ("provider_id", "external_transaction_id"),

        constraint "wager_transactions_wallet_currency_fkey"
          foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency"),
        constraint "wager_transactions_reference_fkey"
          foreign key ("reference_transaction_id")
          references "wager_transactions" ("id"),

        -- Reversão sem referência não é reversão de nada.
        constraint "wager_transactions_reversal_needs_reference"
          check (
            "kind" not in ('REFUND','ROLLBACK')
            or ("reference_external_transaction_id" is not null
                and "reference_external_transaction_id" <> '')
          ),

        -- Terminal e "processed_at" andam juntos, nos dois sentidos.
        constraint "wager_transactions_terminal_has_processed_at"
          check (
            ("status" in ('PROCESSED','REJECTED','FAILED'))
            = ("processed_at" is not null)
          ),

        -- Toda recusa carrega código, e só recusa carrega código: é o que o
        -- provedor precisa para decidir o que fazer.
        constraint "wager_transactions_failure_code_matches_status"
          check (
            ("status" in ('REJECTED','FAILED')) = ("failure_code" is not null)
          ),

        /*
         * O saldo observado existe para o replay: repetir uma operação já
         * processada devolve o saldo daquele momento. Obrigatório no
         * sucesso, opcional na recusa de negócio, ausente nos outros
         * estados. Com uma moeda por linha não há coluna de moeda emparelhada
         * para manter em sincronia com a nulidade desta.
         *
         * Escrita como "case", e não como disjunção de estados conhecidos: na
         * forma disjuntiva um status inválido reprovava aqui **e** em
         * "status_known", e o PostgreSQL relata só uma das duas, à escolha
         * dele. Cada constraint com um trabalho torna o motivo da recusa
         * previsível, o que importa porque é dele que sai a mensagem de erro
         * que alguém vai ler. O ramo "else" continua sendo o restritivo, de
         * modo que a troca não afrouxa nada.
         */
        constraint "wager_transactions_observed_balance_matches_status"
          check (
            case "status"
              when 'PROCESSED' then "observed_balance_amount" is not null
              when 'REJECTED'  then true
              else "observed_balance_amount" is null
            end
          ),

        -- Aguardando referência tem sempre a próxima tentativa agendada, e
        -- nenhum outro estado tem: o worker de referência nunca encontra
        -- transação pendente sem saber quando voltar a ela.
        constraint "wager_transactions_schedule_matches_status"
          check (
            ("status" = 'PENDING_REFERENCE')
            = ("next_reference_attempt_at" is not null)
          )
      )
    `);
    
    /*
      Histórico por wallet, e o índice que a foreign key composta não cria do
      lado que referencia.
    */
    this.addSql(`
      create index "wager_transactions_wallet_created_idx"
        on "wager_transactions" ("wallet_id", "created_at")
    `);

    // Fila do worker de referências pendentes.
    this.addSql(`
      create index "wager_transactions_pending_reference_idx"
        on "wager_transactions" ("next_reference_attempt_at")
        where "status" = 'PENDING_REFERENCE'
    `);

    // Resolução da referência: de "(provider, external id)" para a linha.
    this.addSql(`
      create index "wager_transactions_reference_lookup_idx"
        on "wager_transactions"
           ("provider_id", "reference_external_transaction_id")
        where "reference_external_transaction_id" is not null
    `);

    /*
      A mesma referência não é revertida duas vezes pelo mesmo tipo, e a
      segunda tentativa recebe `ALREADY_REVERSED`. O índice é parcial em dois
      eixos: só
      vale para os tipos que revertem, e só conta reversão que está de pé.
      Recusada ou falhada não reverteu nada, então não pode bloquear uma
      segunda tentativa legítima; em voo bloqueia, e é isso que faz dois
      `ROLLBACK` concorrentes do mesmo `BET` terem um vencedor decidido pelo
      banco, e não pela ordem em que dois processos chegaram.
    */
    this.addSql(`
      create unique index "wager_transactions_single_reversal_idx"
        on "wager_transactions"
           ("provider_id", "reference_external_transaction_id", "kind")
        where "kind" in ('REFUND','ROLLBACK')
          and "status" in ('PENDING','PENDING_REFERENCE','PROCESSED')
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id"                    uuid          not null,
        "wallet_id"             uuid          not null,
        "transaction_id"        uuid          not null,
        "direction"             text          not null,
        "currency"              char(3)       not null,
        "money_amount"          numeric(20,2) not null,
        "balance_before_amount" numeric(20,2) not null,
        "balance_after_amount"  numeric(20,2) not null,
        "created_at"            timestamptz   not null,

        constraint "wallet_ledger_entries_pkey" primary key ("id"),

        constraint "wallet_ledger_entries_direction_known"
          check ("direction" in ('DEBIT','CREDIT')),
        constraint "wallet_ledger_entries_currency_iso"
          check ("currency" ~ '^[A-Z]{3}$'),

        constraint "wallet_ledger_entries_amount_positive"
          check ("money_amount" > 0),
        constraint "wallet_ledger_entries_balance_before_not_negative"
          check ("balance_before_amount" >= 0),
        constraint "wallet_ledger_entries_balance_after_not_negative"
          check ("balance_after_amount" >= 0),

        -- Um lançamento por transação em cada wallet. É a constraint que
        -- torna débito ou crédito duplicado impossível, em vez de improvável:
        -- a segunda tentativa de aplicar a mesma transação colide aqui.
        constraint "wallet_ledger_entries_wallet_transaction_unique"
          unique ("wallet_id", "transaction_id"),

        constraint "wallet_ledger_entries_wallet_currency_fkey"
          foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency"),
        constraint "wallet_ledger_entries_transaction_fkey"
          foreign key ("transaction_id")
          references "wager_transactions" ("id"),

        /*
         * A conta do lançamento fecha. Escrita como disjunção, e não como
         * "case ... else", para ser total por si mesma: direção fora do par
         * conhecido torna os dois lados falsos e a constraint recusa, sem
         * depender de outra constraint para isso.
         *
         * Com duas colunas de moeda por valor esta soma compararia três
         * numeric sem saber se são da mesma moeda, e precisaria de uma
         * segunda constraint de igualdade de moeda para não ser vazia. Com
         * uma moeda por linha ela se sustenta sozinha.
         */
        constraint "wallet_ledger_entries_balances"
          check (
            ("direction" = 'CREDIT'
             and "balance_after_amount"
                 = "balance_before_amount" + "money_amount")
            or
            ("direction" = 'DEBIT'
             and "balance_after_amount"
                 = "balance_before_amount" - "money_amount")
          )
      )
    `);

    this.addSql(`
      comment on column "wallet_ledger_entries"."currency" is
        'Moeda de money_amount, balance_before_amount e balance_after_amount: um lançamento move um valor numa única moeda. Ver ADR-006.'
    `);

    this.addSql(`
      comment on constraint "wallet_ledger_entries_balances"
        on "wallet_ledger_entries" is
        'Restrição 9: a aritmética do lançamento é verificada pelo banco.'
    `);

    // Ordem de leitura do extrato e da reconciliação.
    this.addSql(`
      create index "wallet_ledger_entries_wallet_created_idx"
        on "wallet_ledger_entries" ("wallet_id", "created_at", "id")
    `);

    /*
      Append-only no banco, não só no código.

      Sobrescrever ou excluir lançamento é proibido, e a garantia precisa
      valer no banco. A entidade de domínio é imutável por
      estrutura — não tem campo mutável nem método de transição —, mas isso
      só protege quem passa por ela. O trigger protege o resto.

      `truncate` entra junto: é exclusão em massa, e justamente o comando que
      alguém usaria para "limpar" o ledger. Os testes de integração não
      dependem dele — cada caso usa identificadores próprios, e a suíte
      recria o banco inteiro.
    */
    this.addSql(`
      create function "wallet_ledger_entries_append_only"()
        returns trigger
        language plpgsql
      as $body$
      begin
        raise exception
          'wallet_ledger_entries é append-only: % recusado pelo schema', tg_op
          using errcode = 'restrict_violation';
      end;
      $body$
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_no_update"
        before update on "wallet_ledger_entries"
        for each row execute function "wallet_ledger_entries_append_only"()
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_no_delete"
        before delete on "wallet_ledger_entries"
        for each row execute function "wallet_ledger_entries_append_only"()
    `);

    this.addSql(`
      create trigger "wallet_ledger_entries_no_truncate"
        before truncate on "wallet_ledger_entries"
        for each statement
        execute function "wallet_ledger_entries_append_only"()
    `);

    /*
      Inbox: a deduplicação de consumo.

      Chave primária composta `(consumer_name, message_id)`. O
      `consumer_name` entra na chave porque consumidores diferentes
      podem precisar processar a mesma mensagem de forma independente.

      A linha é gravada na mesma transação do efeito financeiro e o `ack` sai
      depois do commit. Morrer entre as duas coisas faz o SQS reentregar, e a
      mensagem é encontrada aqui — a garantia que nenhum cache em memória
      consegue dar.
    */
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" text        not null,
        "message_id"    text        not null,
        "payload_hash"  char(64)    not null,
        "received_at"   timestamptz not null,
        "processed_at"  timestamptz,
        constraint "inbox_messages_pkey"
          primary key ("consumer_name", "message_id"),
        constraint "inbox_messages_payload_hash_sha256"
          check ("payload_hash" ~ '^[0-9a-f]{64}$')
      )
    `);

    /*
      Outbox: o evento já está no banco quando o commit confirma.

      É assim que a regra "nunca publicar antes do commit" é atendida sem
      transação distribuída. A chave primária é o próprio `eventId`, o que
      torna o enfileiramento idempotente: refazer a operação não cria segunda
      linha.

      Sem foreign key para o agregado, de propósito: o evento é um fato
      ocorrido, e precisa sobreviver independentemente do que aconteça com a
      linha que o originou.
    */
    this.addSql(`
      create table "outbox_messages" (
        "id"              uuid        not null,
        "aggregate_id"    text        not null,
        "event_type"      text        not null,
        "payload"         jsonb       not null,
        "occurred_at"     timestamptz not null,
        "attempts"        int         not null default 0,
        "next_attempt_at" timestamptz,
        "published_at"    timestamptz,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_attempts_not_negative"
          check ("attempts" >= 0)
      )
    `);

    /*
      Índice parcial só dos pendentes: a tabela cresce para sempre, a fila de
      trabalho não. É o que o worker varre com `for update skip locked`.
    */
    this.addSql(`
      create index "outbox_messages_pending_idx"
        on "outbox_messages" ("occurred_at", "id")
        where "published_at" is null
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists "outbox_messages"`);
    this.addSql(`drop table if exists "inbox_messages"`);
    this.addSql(`drop table if exists "wallet_ledger_entries"`);
    this.addSql(`drop function if exists "wallet_ledger_entries_append_only"()`);
    this.addSql(`drop table if exists "wager_transactions"`);
    this.addSql(`drop table if exists "wallets"`);
  }
}
