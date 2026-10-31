# Imagem da aplicação — a mesma para os dois papéis.
#
# Não há etapa de build: o Bun executa TypeScript direto, e introduzir um
# `tsc` que emite JavaScript acrescentaria um artefato intermediário sem
# resolver problema nenhum. O `tsc` continua rodando, como verificação de
# tipos, em `bun run check`.
#
# A versão é fixada, como as de PostgreSQL e MiniStack no Compose: imagem
# flutuante é a diferença entre "funciona aqui" e "funcionava ontem".

FROM oven/bun:1.4.4-alpine AS deps

WORKDIR /app

# Só o manifesto e o lockfile nesta camada: ela só é refeita quando as
# dependências mudam, e não a cada alteração de código.
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile


FROM oven/bun:1.4.4-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json mikro-orm.config.ts ./
COPY src ./src
COPY scripts ./scripts

# A imagem oficial traz o usuário `bun`. Rodar como root dentro do contêiner
# não compra nada aqui e é um passo a menos de defesa se algo escapar.
USER bun

# 3000 é a API; 3001 é a porta de `/health` e `/metrics` do worker.
EXPOSE 3000 3001

# O papel vem do comando, não de uma variável lida pelo código: é o que o
# ADR-001 decidiu — uma aplicação, vários entrypoints.
CMD ["bun", "src/main.ts"]
