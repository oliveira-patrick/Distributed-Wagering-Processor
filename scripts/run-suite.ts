/*
  Roda uma suíte de testes, **um arquivo por processo**.

    bun scripts/run-suite.ts test/integration
    bun scripts/run-suite.ts test/concurrency

  Por que um processo por arquivo, e não `bun test <diretório>`:

  Cada suíte sobe a aplicação de verdade contra um banco e filas descartáveis
  próprios, e aponta para eles ajustando `process.env` antes de importar
  `ConfigModule`. O `NestConfigModule.forRoot` é avaliado no **import**, e o
  import é cacheado pelo processo — então, num processo compartilhado, o
  segundo arquivo recebe o `ConfigModule` do primeiro, já amarrado ao banco e
  às filas dele.

  O sintoma era enganoso e vale registrar: cada arquivo passava sozinho e a
  suíte inteira falhava por timeout, porque os workers do segundo arquivo
  estavam operando no banco do primeiro. Não era lentidão, era alvo errado.

  Sequencial, e não em paralelo: os arquivos criam e derrubam bancos no mesmo
  PostgreSQL e filas no mesmo emulador. Os testes de concorrência, em
  particular, medem contenção — e dois arquivos disputando a mesma máquina
  mediriam a disputa entre eles.
*/
import { Glob } from 'bun';

/*
  Generoso de propósito.

  O default do `bun test` é 5 s, e aqui há cenários que esperam um worker
  assíncrono encontrar trabalho, publicar e comitar, ou três instâncias
  subirem. Com a infraestrutura a frio isso passa de 5 s sem nada estar
  errado. O prazo de cada espera individual continua sendo o do próprio
  teste; este é só o teto do runner.
*/
const PER_TEST_TIMEOUT_MS = 120_000;

const directory = process.argv[2];

if (directory === undefined) {
  console.error('uso: bun scripts/run-suite.ts <diretório>');
  process.exit(1);
}

const glob = new Glob(`${directory}/*.spec.ts`);
const files = [...glob.scanSync('.')].sort();

if (files.length === 0) {
  console.error(`Nenhum arquivo .spec.ts em ${directory}.`);
  process.exit(1);
}

console.log(`${directory}: ${String(files.length)} arquivos, um por processo.`);
console.log('');

const failed: string[] = [];

for (const file of files) {
  console.log(`── ${file}`);

  const result = Bun.spawnSync(
    ['bun', 'test', '--timeout', String(PER_TEST_TIMEOUT_MS), file],
    { stdout: 'inherit', stderr: 'inherit' },
  );

  if (result.exitCode !== 0) {
    failed.push(file);
  }
  console.log('');
}

if (failed.length > 0) {
  console.error(`FALHOU em ${String(failed.length)} arquivo(s):`);
  for (const file of failed) {
    console.error(`  - ${file}`);
  }
  process.exit(1);
}

console.log(`${directory}: ${String(files.length)} arquivos, todos passaram.`);
