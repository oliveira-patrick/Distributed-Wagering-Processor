import { z } from 'zod';

import { openingMoneySchema } from './money.schema';

// Limite de identificadores externos: o provedor é quem os escolhe.
export const EXTERNAL_ID_MAX_LENGTH = 128;

/*
  Entrada de `POST /wallets`.

  `playerId` é `string`, não `uuid`. O identificador do jogador vem do
  provedor e não é nosso — restringir o formato recusaria integrações válidas
  por uma convenção que ninguém pediu. A coluna é `text` pela mesma razão. O
  limite de tamanho existe para que a entrada seja limitada, não para validar
  formato.
*/
export const createWalletSchema = z.object({
  playerId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  initialBalance: openingMoneySchema,
});

export type CreateWalletCommand = z.infer<typeof createWalletSchema>;
