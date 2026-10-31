import type { FailureCode } from './failure-code';

/*
  Raiz dos erros de domínio.

  O `failureCode` viaja junto do erro porque é ele que atravessa a fronteira:
  o provedor recebe o código, não a mensagem. A alternativa — mapear classe
  de erro para código na camada HTTP — obrigaria cada ponto de tradução a
  conhecer a hierarquia inteira, e um ponto esquecido transformaria uma
  rejeição de negócio prevista num 500.
*/
export abstract class DomainError extends Error {
  abstract readonly failureCode: FailureCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
