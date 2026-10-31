import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { ValidationException } from './failure.exception';

/*
  Valida com um schema zod e entrega o valor já convertido.

  Serve corpo e query string — a validação é a mesma operação, e o nome do
  lugar de onde o valor veio não muda nada aqui.

  Para o corpo, o schema é o de `application/contracts`, compartilhado com a
  entrada por fila: é o que garante que `"25"` e `"25.00"` signifiquem a mesma
  coisa nos dois caminhos, e que a recusa de `"25.001"` seja idêntica. Este
  pipe só traduz a falha para HTTP.

  A saída é o tipo **de saída** do schema, não o de entrada: `money` chega como
  `{ amount, currency }` e sai como `Money`, porque a conversão pertence ao
  contrato e não ao controller.
*/
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationException(result.error);
    }

    return result.data;
  }
}
