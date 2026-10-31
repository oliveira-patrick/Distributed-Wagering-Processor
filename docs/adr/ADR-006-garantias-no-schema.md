# ADR-006 — Garantias financeiras no schema do PostgreSQL

- **Status:** Aceito e implementado
- **Data:** 2026-10-29 (status revisado em 2026-10-30)
- **Decidido por:** Patrick Oliveira

## Contexto

A restrição 9 do enunciado é explícita: unicidade, imutabilidade e
não-negatividade precisam viver **no schema**, não apenas no código da
aplicação.

A razão é operacional, não estética. Garantia que mora só no domínio protege
quem passa pelo domínio. Não protege o `psql` aberto às três da manhã para
"corrigir uma linha", não protege o script de migração de dados escrito às
pressas, e não protege a segunda instância que subiu com uma versão diferente
do código — o cenário que a restrição 8 obriga a assumir. Num sistema em que
saldo negativo e débito duplicado são falha eliminatória, a última linha de
defesa precisa estar abaixo da aplicação.

O ADR-004 já tinha apontado para cá: "constraint é o que mais custa mudar
depois", e por isso as decisões de confiabilidade foram tomadas antes do
schema.

## Decisão

Toda invariante que couber numa constraint **é** uma constraint. O domínio
continua validando as mesmas regras, e a duplicação é intencional: o domínio
dá mensagem de erro útil e caminho de negócio, o schema dá a garantia.

### O que o schema garante

| Garantia                                         | Mecanismo                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Saldo nunca negativo                             | `check (balance_amount >= 0)`, idem para `balance_before`/`balance_after`    |
| Idempotência                                     | `unique (idempotency_key)`                                                   |
| Transação do provedor não se repete              | `unique (provider_id, external_transaction_id)`                              |
| Débito ou crédito nunca duplicado                | `unique (wallet_id, transaction_id)` no ledger                               |
| Mesma referência não revertida duas vezes        | índice único parcial `(provider_id, referência, kind)`, só nos estados vivos |
| Mensagem consumida uma vez por consumidor        | chave primária composta `(consumer_name, message_id)`                        |
| A conta do lançamento fecha                      | `check` ligando `balance_before`, `direction`, `money` e `balance_after`     |
| Ledger é append-only                             | trigger que recusa `update`, `delete` e `truncate`                           |
| Moeda da transação e do lançamento é a da wallet | `foreign key (wallet_id, currency)` → `wallets (id, currency)`               |
| Valor monetário é decimal exato                  | `numeric(20, 2)` em toda coluna de dinheiro                                  |
| Coerência de ciclo de vida                       | quatro `check` ligando `status` a `processed_at`, `failure_code`,            |
|                                                  | `observed_balance_amount` e `next_reference_attempt_at`                      |
| Formato de moeda e de hash                       | `check` com regex ISO-4217 e SHA-256 hexadecimal                             |

### O que **não** vai para o schema

- **A taxonomia de `failure_code`.** Ela não governa constraint nenhuma, o
  enunciado a deixa explicitamente a cargo do candidato, e ela cresce. O tipo
  em TypeScript já impede o erro de digitação, e o mapper recusa valor fora da
  lista na leitura.
- **As 8 tentativas em 24 horas da referência pendente** e a política de
  backoff. São regra de negócio com janela de tempo, não invariante estrutural.
- **A ordem das transições de estado.** O schema garante a coerência de cada
  linha; que `PROCESSED` não volte para `PENDING` é do domínio, porque depende
  do estado anterior e não do estado atual.

### `text` com `check`, não `enum` do PostgreSQL

`alter type ... add value` não convive bem com migration transacional, e o
domínio já representa `kind`, `status` e `direction` como union de literais de
string. Os três aparecem no schema porque as próprias constraints dependem
deles — a aritmética do lançamento é escrita em termos de `DEBIT` e `CREDIT`.

### Uma constraint, um trabalho

Quando duas constraints recusam a mesma linha, o PostgreSQL relata só uma, à
escolha dele, e a mensagem de erro fica imprevisível. Onde dá para separar sem
afrouxar, separa-se: `observed_balance_matches_status` foi reescrita como
`case` justamente para parar de reprovar status desconhecido, trabalho que é
de `status_known`.

Onde **não** dá, a sobreposição fica e está documentada no teste:
`wallet_ledger_entries_balances` é uma disjunção que também recusa direção
desconhecida, e assim ela é total por si mesma. A alternativa — um `case` com
`else true` — deixaria a aritmética passar e faria a garantia depender de
outra constraint estar lá. Previsibilidade de mensagem não vale esse preço.

## Verificação

`test/integration/schema-constraints.spec.ts` escreve **SQL cru**, por fora do
domínio e dos mappers, e verifica que cada garantia recusa. São 44 casos
contra PostgreSQL 17.6 real, executados em 2026-10-30 — 44 passando, 0
falhando. Entre eles: update, delete e truncate recusados no ledger, com
verificação de que a linha permanece intacta depois das tentativas.

A suíte prova a recusa. Ela **não** prova ausência de garantia faltando: nada
impede que uma invariante exista no domínio e não tenha constraint
correspondente. Isso continua dependendo de revisão de código.

## Consequências

**Positivas**

- As invariantes valem para qualquer caminho de escrita, incluindo os que
  ninguém previu.
- A unicidade vira o mecanismo de concorrência, em vez de só uma proteção:
  "inserir e tratar a violação" funciona com N instâncias, enquanto "consultar
  antes de inserir" não.
- Divergência entre schema e domínio aparece como erro de escrita, não como
  dado inconsistente descoberto meses depois.

**Negativas**

- Toda mudança de regra que esteja numa constraint exige migration. É o custo
  que o ADR-004 antecipou.
- A duplicação domínio/schema pode divergir: nada força as duas a contarem a
  mesma história, e a sincronia depende de revisão.
- O trigger de append-only bloqueia também manutenção legítima. Corrigir um
  lançamento errado exige estorno contábil, não `update` — o que é correto
  para um ledger e incômodo em outras situações.
- `check` e índice único custam em cada escrita. São cinco escritas por
  operação, e cada uma paga a verificação.
- A mensagem de erro do PostgreSQL é grossa: o nome da constraint é a única
  informação estruturada, e extraí-lo exige percorrer a cadeia de causas do
  erro do driver.

**Neutras**

- Alguns `check` restringem mais do que o enunciado pede — por exemplo, exigir
  `observed_balance_amount` em toda transação `PROCESSED`. É consequência de
  ter decidido que o replay sempre devolve saldo, e não de uma exigência
  externa.

## Alternativas consideradas

**Garantias só no domínio, schema permissivo.** Descartada pela restrição 9, e
haveria motivo mesmo sem ela: é a arquitetura em que um `update` manual
produz saldo negativo sem que nada reclame.

**Camada de serviço validando antes de toda escrita.** Descartada. É a mesma
garantia no mesmo lugar — dentro do processo da aplicação —, com a ilusão
extra de estar numa "camada de proteção". Duas instâncias a atravessam ao
mesmo tempo sem perceber.

**Schema gerado a partir das entidades (`schema:update`).** Descartada. O
gerador não produz trigger, índice parcial com predicado nem `check` composto,
que é exatamente o conteúdo desta decisão. O schema é propriedade das
migrations.

**`enum` do PostgreSQL para `kind`, `status` e `direction`.** Descartada pela
incompatibilidade entre `alter type ... add value` e migration transacional.

## Revisitar quando

- A sobrecarga de verificação aparecer na medição sob carga realista — o que
  só dá para saber depois do teste de carga opcional.
- Alguma regra hoje em `check` passar a depender de contexto que a linha não
  tem, caso em que ela precisa migrar para o domínio em vez de virar um
  `check` com subconsulta.
- O ledger precisar de particionamento, que muda como o trigger e os índices
  se comportam.
