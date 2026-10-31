/*
  Topologia das filas.

  Declarada em um único lugar para que o script de bootstrap, os health
  checks e os testes de integração concordem sobre nomes e atributos. Um
  valor divergente entre quem cria a fila e quem a consome é o tipo de erro
  que só aparece sob carga.
*/

/*
  Tentativas de entrega antes de a mensagem ir para a DLQ.

  Cinco é um meio-termo deliberado: alto o suficiente para absorver uma
  indisponibilidade curta de PostgreSQL — o retry com backoff da aplicação
  cobre a janela —, e baixo o suficiente para que uma mensagem
  verdadeiramente venenosa saia do fluxo rápido, em vez de consumir
  capacidade do consumidor indefinidamente.
*/
export const MAX_RECEIVE_COUNT = 5;

/*
  Deve ser maior que o pior caso de processamento de uma transação, senão a
  mensagem reaparece para outro consumidor enquanto o primeiro ainda está
  dentro da transação SQL — redelivery que o inbox absorve, mas que gera
  trabalho duplicado à toa.
*/
export const VISIBILITY_TIMEOUT_SECONDS = 30;

// Quatro dias: cobre um fim de semana inteiro de indisponibilidade.
export const MESSAGE_RETENTION_SECONDS = 345_600;

// Long polling: reduz chamadas vazias sem atrasar a entrega.
export const RECEIVE_WAIT_TIME_SECONDS = 20;

// Atributos da DLQ. Uma DLQ de fila FIFO precisa ser, ela própria, FIFO.
export function deadLetterQueueAttributes(): Record<string, string> {
  return {
    FifoQueue: 'true',
    MessageRetentionPeriod: String(MESSAGE_RETENTION_SECONDS),
  };
}

/*
  Atributos da fila principal.

  `ContentBasedDeduplication` fica desligado de propósito: a deduplicação do
  broker é calculada sobre o corpo da mensagem, e duas operações legítimas
  podem ter corpos idênticos. Quem publica informa um
  `MessageDeduplicationId` explícito. De todo modo, a janela de deduplicação
  do SQS é de cinco minutos — ela é otimização, não garantia; a garantia é o
  inbox persistente.
*/
export function mainQueueAttributes(
  deadLetterQueueArn: string,
): Record<string, string> {
  return {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
    MessageRetentionPeriod: String(MESSAGE_RETENTION_SECONDS),
    ReceiveMessageWaitTimeSeconds: String(RECEIVE_WAIT_TIME_SECONDS),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: deadLetterQueueArn,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    }),
  };
}

/*
  Atributos da fila de **saída** dos eventos de integração.

  Os eventos de integração precisam sair para algum lugar, e esse lugar não
  pode ser a fila de entrada: ela
  carrega comandos (`WagerTransactionRequested`), e publicar evento nela
  faria o próprio consumidor recebê-los de volta, obrigando-o a filtrar por
  tipo o que nunca deveria ter chegado. Fila separada, decisão registrada no
  ADR-012.

  FIFO também aqui, pelo mesmo motivo da entrada: a ordenação relativa dos
  eventos de uma mesma wallet é o que permite a um consumidor externo
  reconstruir o saldo. O grupo é a `walletId`, que os eventos já expõem como
  `aggregateId`.

  `ContentBasedDeduplication` desligado: quem publica informa o `eventId`
  como `MessageDeduplicationId`, e é isso que torna inofensiva a republicação
  de um evento cujo `markPublished` não chegou a comitar.
*/
export function eventsQueueAttributes(
  deadLetterQueueArn: string,
): Record<string, string> {
  return {
    FifoQueue: 'true',
    ContentBasedDeduplication: 'false',
    VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
    MessageRetentionPeriod: String(MESSAGE_RETENTION_SECONDS),
    ReceiveMessageWaitTimeSeconds: String(RECEIVE_WAIT_TIME_SECONDS),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: deadLetterQueueArn,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    }),
  };
}
