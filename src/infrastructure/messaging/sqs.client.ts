import { SQSClient } from '@aws-sdk/client-sqs';

import type { SqsTransportConfig } from '../../config/env.service';

// Token de injeção do cliente SQS.
export const SQS_CLIENT = Symbol('SQS_CLIENT');

/*
  Tentativas por operação, contando a primeira.

  O SDK já aplica backoff exponencial com jitter entre elas, e isso cobre a
  oscilação curta — a indisponibilidade de segundos que se deve assumir. O
  que **não** se delega a ele é a retentativa de negócio: uma mensagem que
  falha por indisponibilidade persistente não é reenviada aqui,
  ela deixa de receber `ack` e volta pela fila. São dois níveis diferentes, e
  confundi-los faria o consumidor segurar uma mensagem muito mais tempo que o
  visibility timeout.
*/
export const SQS_MAX_ATTEMPTS = 3;

export interface SqsHttpOptions {
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
  readonly throwOnRequestTimeout: true;
}

/*
  Prazos do transporte.

  Exportado separado do cliente para que a relação entre `requestTimeout` e o
  long poll seja verificável por teste, e não só afirmada em comentário.

  `requestTimeout` é o teto da operação legítima mais lenta, que é um
  `ReceiveMessage` com long poll de até `MAX_LONG_POLL_SECONDS` segundos — a
  constante mora no contrato de ambiente, que é onde o piso deste prazo é
  validado. Por isso ele é generoso, e por isso quem precisa de prazo mais
  curto — o health check, por exemplo — passa um `AbortSignal` próprio em vez
  de contar com este número.

  `connectionTimeout` é curto: não conseguir abrir a conexão é indisponibilidade
  imediata, sem nada a esperar.

  `throwOnRequestTimeout` **não é detalhe**. Por padrão, o
  `@smithy/node-http-handler` trata o estouro de `requestTimeout` como aviso:
  emite um `[WARN]` no log e deixa a requisição seguir esperando. Configurar o
  prazo sem esta flag dá falsa sensação de segurança — o número está lá, o
  aviso aparece, e a chamada continua pendurada do mesmo jeito. Medido contra
  um endpoint que aceita a conexão e não responde: sem a flag, 6 s depois a
  chamada ainda não tinha terminado.
*/
export function sqsHttpOptions(config: SqsTransportConfig): SqsHttpOptions {
  return {
    connectionTimeout: config.connectionTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    throwOnRequestTimeout: true,
  };
}

/*
  Cria o cliente do SDK.

  O endpoint só é sobrescrito quando há um emulador configurado. Com
  `SQS_ENDPOINT` vazio, o SDK resolve o endpoint real da AWS sozinho — é o
  único ponto do código que sabe da existência de um emulador, e ele não
  sabe qual.

  Os prazos são **explícitos** porque o default do handler HTTP do SDK é
  `requestTimeout: 0`, isto é, sem limite: um endpoint que completa o
  handshake e nunca responde pendura a chamada indefinidamente. Timeout é
  indisponibilidade, e indisponibilidade tem de virar erro rápido e
  classificável — nunca espera sem fim.
*/
export function createSqsClient(config: SqsTransportConfig): SQSClient {
  return new SQSClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    maxAttempts: SQS_MAX_ATTEMPTS,
    requestHandler: sqsHttpOptions(config),
    ...(config.endpoint === '' ? {} : { endpoint: config.endpoint }),
  });
}
