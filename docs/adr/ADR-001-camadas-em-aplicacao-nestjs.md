# ADR-001 — Camadas dentro de uma única aplicação NestJS

- **Status:** Aceito
- **Data:** 2026-10-29
- **Decidido por:** Patrick Oliveira

## Contexto

O desafio pede um "serviço financeiro distribuído" e exige, na seção 8, que a
solução continue correta com **três ou mais instâncias** rodando ao mesmo
tempo. São três cargas de trabalho bem diferentes entre si:

1. a API HTTP, que responde às requisições dos provedores;
2. o consumidor da fila SQS, que processa as mesmas operações quando elas
   chegam por mensagem;
3. workers em segundo plano, que publicam a outbox e reprocessam transações
   em `PENDING_REFERENCE`.

A palavra "distribuído" puxa naturalmente para serviços separados. Mas há três
motivos para ler a exigência de outro jeito.

**O que está em jogo é o estado compartilhado, não quantos serviços existem.**
"Correto com múltiplas instâncias" quer dizer que a corretude não pode
depender do que um processo guarda em memória. Três cópias do mesmo processo
cobram isso tanto quanto três serviços distintos — tanto que o enunciado
proíbe justamente idempotência em memória e lock global, que são as duas
maneiras clássicas de errar nesse ponto.

**O consumidor tem de reaproveitar o mesmo use case da API.** A seção 10 é
literal: "reutilizar **o mesmo use case** da entrada HTTP". Com dois
deployables separados, esse código viraria uma biblioteca compartilhada, com
versionamento entre as partes — puro custo, enquanto as duas evoluem juntas.

**Alguém precisa subir isso para avaliar.** Cada serviço a mais significa mais
uma imagem, mais uma entrada no Compose e mais uma coisa capaz de falhar na
máquina de quem está corrigindo o desafio.

## Decisão

Uma **única aplicação NestJS**, organizada por dentro em quatro camadas de
Clean Architecture, que assume papéis diferentes conforme o entrypoint usado,
sempre sobre a mesma raiz de composição.

As camadas e para onde cada uma pode apontar:

- `domain` — entidades, objetos de valor e invariantes. Não referencia nada:
  nem NestJS, nem ORM, nem SDK.
- `application` — casos de uso e portas. Só referencia `domain`.
- `infrastructure` — adaptadores que implementam as portas: MikroORM, SQS.
- `interfaces` — controllers HTTP e, mais à frente, o consumidor de fila.

Escalar aqui quer dizer rodar N cópias do processo, não N serviços.

## Consequências

**Positivas**

- Um use case, uma implementação. HTTP e fila chamam exatamente o mesmo
  código, como o enunciado exige, sem nenhuma biblioteca no meio.
- Um artefato só para construir, rodar e depurar, e um `docker compose up` que
  continua curto.
- A corretude vai parar onde ela precisa estar: no PostgreSQL. Como nenhum
  papel pode resolver nada por estado compartilhado em memória, as invariantes
  acabam descendo para o schema — que é o que a restrição 9 pede.
- A decisão continua reversível. As costuras entre os entrypoints são
  exatamente por onde a separação em serviços passaria.

**Negativas**

- API e workers escalam juntos. Se o consumo da fila precisar de escala
  própria, aí não tem como fugir da extração que este ADR adia.
- Um domínio de falha só por processo: um vazamento de memória no worker leva
  junto a API daquela instância.
- Nada no build impede que `domain` importe de `infrastructure`. Em .NET, as
  referências de projeto dariam conta disso; aqui a regra depende de revisão
  até existir uma regra de ESLint sobre caminhos de import.

**Neutras**

- Os workers começam como processos lançados pelo mesmo binário com argumento
  diferente, e só viram imagens separadas quando o perfil de recursos exigir.

## Alternativas consideradas

**Microsserviços desde o início — API, consumidor e workers separados.**
Descartado. Obrigaria o use case compartilhado a virar pacote versionado,
multiplicaria a infraestrutura local e não acrescentaria nada àquilo que o
enunciado realmente cobra, que é corretude sob concorrência. Fora que as
fronteiras entre esses três papéis não são fronteiras de domínio, e sim de
_transporte_ sobre o mesmo domínio.

**Monólito em camadas, sem fronteira explícita entre domínio e
infraestrutura.** Descartado. Rende mais no começo, mas deixa o domínio
financeiro grudado no ORM, e aí não há como testar as invariantes sem subir um
banco. "Invariantes encapsuladas em classes" é critério de nota no enunciado.

**Organização por feature em vez de por camada** (`modules/wallet/*`,
`modules/wagering/*`, cada um com suas próprias subcamadas). Descartado por
pouco. É idiomático em NestJS e funciona bem, mas o que está sendo avaliado
aqui é a regra de dependência, e com as camadas no topo ela fica visível já na
árvore de diretórios. Com só dois agregados, organizar por feature economizaria
pouca coisa.

## Revisitar quando

- A vazão do consumidor de fila exigir escala independente da API.
- Aparecer um terceiro agregado e as fronteiras de domínio ficarem claras o
  bastante para justificar a extração.
- O tempo de inicialização do processo único começar a atrapalhar o ciclo de
  desenvolvimento.
