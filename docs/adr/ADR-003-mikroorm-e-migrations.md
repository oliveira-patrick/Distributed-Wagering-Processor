# ADR-003 — MikroORM e migrations versionadas

- **Status:** Aceito
- **Data:** 2026-10-29
- **Decidido por:** Patrick Oliveira

## Contexto

O enunciado limita o ORM a duas opções — "**MikroORM** — preferencial" ou
"**TypeORM** — aceito" — e cobra migrations "versionadas e reversíveis".
Prisma fica de fora por decisão explícita dele.

Aqui a escolha não é questão de gosto. Três restrições invioláveis dependem
direto do que o ORM entrega:

- **restrição 4** — nenhum evento pode ser publicado antes do commit da
  transação financeira, o que pede uma fronteira transacional explícita e
  previsível;
- **restrição 7** — o saldo não pode ser `read → calculate → update` sem
  controle de concorrência, o que pede locking de primeira classe;
- **restrição 9** — unicidade, imutabilidade e não-negatividade precisam estar
  **no schema**, o que pede migrations capazes de expressar qualquer
  constraint, e não apenas aquilo que o ORM consegue inferir de decorators.

Junte a isso a seção 11: transação, saldo, ledger, inbox e outbox têm de ser
**atômicos** — cinco escritas em quatro tabelas, num commit só.

## Decisão

**MikroORM 7** com o driver de PostgreSQL, e migrations geradas e aplicadas
pela CLI do próprio ORM.

O que pesou, em ordem:

1. **Unit of Work explícito.** As mudanças de uma operação se acumulam e vão
   para o banco num commit só. Com isso, a atomicidade que a seção 11 exige
   vira o caminho natural, e não o caminho cuidadoso que alguém precisa
   lembrar de seguir.
2. **`EntityManager.transactional()`.** A fronteira da transação aparece no
   código como um bloco, com início e fim à vista. É ali que a leitura do
   saldo, a decisão de negócio, a escrita do ledger e o registro na outbox
   ficam visivelmente juntos.
3. **`LockMode` de primeira classe.** `PESSIMISTIC_WRITE` mapeia direto para
   `SELECT ... FOR UPDATE`, e o locking otimista por `version` vem nativo. São
   as duas estratégias que a seção 8 cita, e ambas ficam disponíveis sem
   escrever SQL na mão.
4. **Identity Map.** Dentro de uma transação, carregar a mesma wallet duas
   vezes devolve a mesma instância. Em código que mexe com saldo, ter duas
   cópias divergentes do mesmo agregado seria uma classe inteira de bug — e
   ela simplesmente deixa de existir.

### Configuração das migrations

Uma função só, `buildMikroOrmConfig`, atende dois chamadores: o módulo Nest,
na inicialização, e a CLI, na hora de criar e aplicar migrations. Uma
definição única impede que aplicação e migrations passem a discordar sobre o
schema.

| Opção           | Valor   | Razão                                                                                 |
| --------------- | ------- | ------------------------------------------------------------------------------------- |
| `transactional` | `true`  | cada migration roda na própria transação                                              |
| `allOrNothing`  | `true`  | se uma falha, o lote inteiro é revertido                                              |
| `snapshot`      | `false` | o diff é calculado contra o banco real, não contra um arquivo que pode ficar defasado |
| `emit`          | `'ts'`  | migrations são código revisável, não SQL opaco                                        |

Não existe sincronização automática de schema em ambiente nenhum. O schema
pertence às migrations.

## Consequências

**Positivas**

- A atomicidade entre as cinco escritas se expressa de forma direta, e violar
  a restrição 4 por acidente fica difícil.
- As duas estratégias de concorrência que o enunciado cita ficam à mão sem SQL
  manual, o que mantém reversível a decisão registrada na seção 4 do
  [ARCHITECTURE.md](../../ARCHITECTURE.md).
- Migrations em TypeScript passam por revisão de código como qualquer outro
  arquivo. Constraints `CHECK` e índices parciais, que o ORM não infere de
  decorators, são escritos à mão exatamente onde precisam estar.
- O `allOrNothing` elimina o estado mais chato de diagnosticar, que é o schema
  pela metade.

**Negativas**

- O MikroORM 7 só funciona em **ESM** e exige Node 22.17 ou superior. O
  ambiente atende, mas sem nenhuma folga.
- O suporte a Bun quem declara é o próprio projeto, sem verificação
  independente. Conexão, transações e o ciclo completo de migrations já foram
  exercitados aqui, mas **discovery de entidades e custom types continuam sem
  teste** — e é justamente onde o mapeamento de `Money` vai morar.
- É mais lento que um driver cru. Pouco importa neste caso: o gargalo do
  domínio é o lock por wallet, não o mapeamento.
- A CLI exige um banco no ar até para gerar uma migration em branco, o que
  amarra uma tarefa de desenvolvimento à infraestrutura estar de pé.

**Neutras**

- O `Money` não vai depender de tipos monetários do ORM. A conversão fica num
  custom type, e o domínio segue sem saber que existe um ORM.

## Alternativas consideradas

**TypeORM.** Descartado. O enunciado aceita e o ecossistema é maior, mas o
Unit of Work dele é implícito e transações aninhadas têm histórico de
surpresas — risco que não compensa num domínio onde atomicidade vale nota. O
enunciado ainda sinaliza preferência pelo MikroORM, e contrariá-la exigiria
uma razão técnica mais forte do que familiaridade.

**Driver `pg` cru com SQL escrito à mão.** Descartado, mesmo sendo tentador.
Daria controle total sobre o locking e sobre o SQL exato de cada operação, e
cortaria de uma vez a incerteza em torno do Bun. Só que seria preciso
reconstruir Unit of Work e Identity Map na mão, e o enunciado pede um dos dois
ORMs que ele nomeia.

**Prisma.** Fora de escopo por decisão do enunciado. Seria descartado de
qualquer jeito: o modelo de transação interativa é mais restrito, e o locking
pessimista exigiria SQL cru, o que joga fora justamente o que se busca num
ORM.

**`migration:create --initial` a partir dos metadados das entidades.**
Descartado para as constraints. Ele gera o schema que o ORM infere dos
decorators, e as garantias da restrição 9 — `CHECK (balance_amount >= 0)`,
índices únicos parciais, imutabilidade por trigger ou por ausência de
permissão — não saem de decorator nenhum. Essas vão ser escritas à mão.

## Revisitar quando

- O primeiro mapeamento de entidade sob Bun falhar de um jeito que aponte
  incompatibilidade estrutural, e não erro de configuração.
- O custo do mapeamento aparecer em medição de latência, o que só será
  possível depois do teste de carga opcional.
- Alguma operação exigir SQL que o query builder não expresse. Nesse caso a
  saída é SQL cru pontual dentro da mesma transação, não trocar de ORM.
