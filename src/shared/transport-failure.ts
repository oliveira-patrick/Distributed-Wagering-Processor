/*
  Reconhece falha de **transporte** — indisponibilidade, não erro de negócio.

  A API precisa distinguir "falha transitória de infraestrutura" das outras
  quatro situações, e a distinção tem consequência prática: um 503 diz
  ao provedor "reenvie", e um 500 diz "não reenvie, isto é bug". Colapsar as
  duas faz o provedor desistir de uma operação que daria certo na segunda
  tentativa, ou insistir numa que nunca vai dar.

  A detecção é por código, sem importar tipo de biblioteca nenhuma: o erro do
  driver vem envolto pelo ORM, e depender da classe do invólucro amarraria
  esta decisão à versão do ORM. SQLSTATE e código de socket são estáveis.
*/

// SQLSTATE: 08 conexão, 53 recursos esgotados, 57 intervenção do operador.
const TRANSIENT_SQLSTATE_CLASSES = ['08', '53', '57'];

const TRANSIENT_SOCKET_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
];

// Nomes que o SDK da AWS e o prazo próprio usam para estouro e cancelamento.
const TRANSIENT_ERROR_NAMES = [
  'TimeoutError',
  'AbortError',
  'DeadlineExceededError',
];

const MAX_DEPTH = 5;

interface ErrorShape {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly cause?: unknown;
  readonly previous?: unknown;
  readonly errors?: unknown;
}

function chain(error: unknown, depth = 0): readonly ErrorShape[] {
  if (depth > MAX_DEPTH || typeof error !== 'object' || error === null) {
    return [];
  }

  const node = error as ErrorShape;
  const aggregated = Array.isArray(node.errors) ? node.errors : [];

  return [
    node,
    ...chain(node.cause, depth + 1),
    ...chain(node.previous, depth + 1),
    ...aggregated.flatMap((inner) => chain(inner, depth + 1)),
  ];
}

function looksTransient(node: ErrorShape): boolean {
  if (
    typeof node.name === 'string' &&
    TRANSIENT_ERROR_NAMES.includes(node.name)
  ) {
    return true;
  }

  const code = node.code;
  if (typeof code !== 'string') {
    return false;
  }

  if (TRANSIENT_SOCKET_CODES.includes(code)) {
    return true;
  }

  /*
    SQLSTATE tem exatamente cinco caracteres, e os dois primeiros são a
    classe. Um `ECONNREFUSED` não passa por aqui porque não tem esse formato.
  */
  return (
    code.length === 5 && TRANSIENT_SQLSTATE_CLASSES.includes(code.slice(0, 2))
  );
}

export function isTransportFailure(error: unknown): boolean {
  return chain(error).some(looksTransient);
}
