import { z } from 'zod';

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

/*
  Query do extrato — `?cursor=...&limit=50`.

  O teto de `limit` existe porque o parâmetro é do cliente: sem ele, um
  `limit=1000000` transforma uma consulta paginada numa varredura do ledger
  inteiro. Pedir mais que o teto é recusa, não truncamento silencioso — quem
  integra precisa saber que não recebeu o que pediu.
*/
export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LEDGER_PAGE_MAX_LIMIT)
    .default(LEDGER_PAGE_DEFAULT_LIMIT),
});

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
