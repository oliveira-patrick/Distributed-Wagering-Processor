import { z } from 'zod';

import { EXTERNAL_ID_MAX_LENGTH } from './create-wallet.command';
import {
  requireReferenceWhenKindDemands,
  submitWagerTransactionObject,
} from './submit-wager-transaction.command';

/*
  O único tipo de mensagem que a fila de entrada carrega.

  `z.literal` e não `z.string()`: a fila é canal interno confiável quanto ao
  transporte, não quanto ao conteúdo. Uma mensagem de outro tipo caindo aqui
  é erro de configuração de quem publica, e aceitar o campo como string livre
  faria o consumidor processá-la como se fosse uma submissão.
*/
export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/*
  O `data` da mensagem: o mesmo payload de negócio do HTTP, mais a chave de
  idempotência.

  No HTTP a chave vem no header `Idempotency-Key`; aqui ela vem no corpo,
  porque mensagem não tem header de requisição. O que **não** muda é que ela
  fica fora do hash de payload: header e metadado de transporte não entram,
  e a chave é metadado de transporte nas duas portas.
  É `submitWagerTransactionObject` — sem a chave — que alimenta o hash.
*/
const wagerMessageDataSchema = submitWagerTransactionObject
  .extend({
    idempotencyKey: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  })
  .superRefine(requireReferenceWhenKindDemands);

/*
  Envelope da mensagem de entrada.

  `messageId` é metade da chave do inbox — a outra é o nome do consumidor —, e
  por isso é obrigatório e não vazio: sem ele não há deduplicação persistente,
  que é a única garantia que sobrevive a uma queda do processo.

  `occurredAt` entra como string ISO e é convertido aqui. Mensagem com data
  inválida é payload malformado, e payload malformado é erro **permanente**:
  reentregar não melhora nada, então ele vai direto para a DLQ em vez de
  gastar as cinco entregas do `maxReceiveCount`.
*/
export const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  type: z.literal(WAGER_MESSAGE_TYPE),
  occurredAt: z.coerce.date(),
  data: wagerMessageDataSchema,
  /*
    Opcional: o envelope publicado pelos provedores não o inclui. Quando
    vem, a correlação do provedor atravessa o sistema e chega aos eventos de
    integração; quando não vem, o consumidor gera uma.
  */
  correlationId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH).optional(),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
export type WagerMessageData = WagerMessage['data'];
