/*
  Resultado da resolução de identidade do provedor.

  Duas situações, e a distinção importa: um canal **sem** identidade
  autenticada não é o mesmo que um canal cuja identidade não casa com o
  payload. No primeiro caso não há nada a conferir; no segundo, há uma
  divergência e ela é recusa.
*/
export type ProviderAuthorization =
  | { readonly authenticated: false }
  | { readonly authenticated: true; readonly providerId: string };

/*
  Ponto de extensão de autenticação.

  A decisão registrada no `ARCHITECTURE.md` é **não implementar**
  autenticação, e em troca deixar o ponto de extensão explícito. O que a
  seção pede em troca é que o ponto de extensão esteja explícito no código, e
  é esta porta.

  Ela não é decorativa. O caso de uso **chama** `resolve` e, quando a
  identidade vem autenticada, exige que o `providerId` dela coincida com o do
  payload — a conferência que o `ARCHITECTURE.md` descreve para o desenho
  com Keycloak. Com a implementação no-op de hoje a resposta é sempre "canal
  sem identidade", então nada é recusado; trocar a implementação por uma que
  valide JWT por JWKS liga a verificação sem tocar no caso de uso. Há teste de
  unidade exercitando o caminho autenticado, justamente para que a costura não
  seja só uma promessa.

  Mensagens da fila são canal interno confiável **quanto ao transporte**, e não
  quanto ao conteúdo: o `providerId` que vem na mensagem continua passando
  pelas validações de domínio.
*/
export interface ProviderIdentityPort {
  /*
    @param credential o que o transporte trouxe — hoje o header
      `Authorization` do HTTP, `undefined` quando a entrada é a fila.
  */
  resolve(credential: string | undefined): Promise<ProviderAuthorization>;
}

// Token de injeção: a interface não existe em tempo de execução.
export const PROVIDER_IDENTITY = 'PROVIDER_IDENTITY';
