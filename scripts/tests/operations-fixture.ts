import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { availablePort } from '../lib/environments';
import { buildImage } from '../lib/image';
import { runCommand, type CommandResult } from '../lib/command';
import { stateSchema, type InstallationState } from '../lib/operations-config';
import { removeOwnedContainer } from './owned-container';
import { withCleanup } from './cleanup';

interface OperationsFixture {
  directory: string;
  images: Record<string, string>;
  tags: string[];
  registryPort: number;
  execute: (args: string[], timeout?: number) => Promise<string>;
  ops: (action: string, ...args: string[]) => Promise<string>;
  opsResult: (action: string, ...args: string[]) => Promise<CommandResult>;
  state: () => InstallationState;
  compose: (args: string[]) => Promise<string>;
  digest: (tag: string) => Promise<string>;
  variant: (
    kind:
      | 'compatible'
      | 'failure'
      | 'interrupted'
      | 'incompatible'
      | 'process'
      | 'http'
      | 'addition',
  ) => Promise<string>;
  cleanup: () => Promise<void>;
  request: (
    path: string,
    options?: { method?: string; data?: unknown },
  ) => Promise<unknown>;
}

export async function operationsFixture(): Promise<OperationsFixture> {
  const id = randomUUID();
  const directory = resolve('.context/test-runs', `operations-${id}`);
  const secrets = join(directory, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const execute = async (args: string[], timeout = 120_000) => {
    const result = await runCommand(args, {
      cwd: process.cwd(),
      timeout,
      maxOutput: 1_000_000,
    });
    if (result.code !== 0)
      throw new Error(
        `${args.slice(0, 3).join(' ')} failed: ${result.stdout}${result.stderr}`,
      );
    return result.stdout.trim();
  };
  const registryPort = await availablePort();
  const httpsPort = await availablePort();
  const registry = { name: `ddh-operations-registry-${id}`, owner: id };
  const images: Record<string, string> = {};
  let compatibleImage: string | undefined;
  const tags: string[] = [];
  const collected = new Set<string>();
  const results: { action: string; code: number }[] = [];
  const collectDiagnostics = () => {
    const logs = join(directory, 'logs');
    if (!existsSync(logs)) return;
    for (const id of readdirSync(logs)) {
      if (collected.has(id)) continue;
      const file = join(logs, id, 'run.log');
      if (existsSync(file))
        appendFileSync(join(directory, 'run.log'), readFileSync(file), {
          mode: 0o600,
        });
      collected.add(id);
    }
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ results }), {
      mode: 0o600,
    });
  };
  const opsResult = async (action: string, ...args: string[]) => {
    const result = await runCommand(
      ['bun', 'run', 'ops', `--directory=${directory}`, action, ...args],
      { cwd: process.cwd(), timeout: 150_000, maxOutput: 1_000_000 },
    );
    results.push({ action, code: result.code });
    collectDiagnostics();
    return result;
  };
  const ops = async (action: string, ...args: string[]) => {
    const result = await opsResult(action, ...args);
    if (result.code !== 0)
      throw new Error(
        `ops ${action} failed: ${result.stdout}${result.stderr}. Inventory: ${directory}`,
      );
    return result.stdout;
  };
  const state = () =>
    stateSchema.parse(
      JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')),
    );
  const compose = (args: string[]) =>
    execute([
      'docker',
      'compose',
      '-p',
      state().project,
      '-f',
      join(directory, 'compose.json'),
      ...args,
    ]);
  const digest = async (tag: string) => {
    await execute(['docker', 'push', tag]);
    const digests = z
      .array(z.string())
      .parse(
        JSON.parse(
          await execute([
            'docker',
            'image',
            'inspect',
            '--format',
            '{{json .RepoDigests}}',
            tag,
          ]),
        ),
      );
    const selected = digests.find((value) =>
      value.startsWith(`127.0.0.1:${String(registryPort)}/`),
    );
    if (!selected)
      throw new Error('Disposable registry did not return a digest');
    return selected;
  };
  const cleanup = () =>
    withCleanup(async () => {
      if (existsSync(join(directory, 'state.json'))) await ops('down');
    }, [
      () => removeOwnedContainer(registry),
      async () => {
        if (tags.length) await execute(['docker', 'image', 'rm', ...tags]);
      },
    ]);
  try {
    await execute([
      'docker',
      'run',
      '-d',
      '--name',
      registry.name,
      '--label',
      `dev.starter.owner=${id}`,
      '-p',
      `127.0.0.1:${String(registryPort)}:5000`,
      '--tmpfs',
      '/var/lib/registry',
      'registry:2',
    ]);
    for (const name of ['user', 'wallet']) {
      const tag = `127.0.0.1:${String(registryPort)}/${name}:baseline`;
      await buildImage(name, { tag });
      tags.push(tag);
      images[name] = await digest(tag);
      for (const role of ['admin', 'owner', 'runtime'])
        writeFileSync(
          join(secrets, `${name}-${role}-password`),
          `${randomUUID()}\n`,
          { mode: 0o444 },
        );
    }
    writeFileSync(join(secrets, 'broker-password'), `${randomUUID()}\n`, {
      mode: 0o444,
    });
    await execute([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(secrets, 'tls.key'),
      '-out',
      join(secrets, 'tls.crt'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);
    // Compose file secrets preserve host permissions, including on Linux CI.
    await execute(['chmod', '444', join(secrets, 'tls.key')]);
    writeFileSync(
      join(directory, 'deployment.json'),
      JSON.stringify({
        name: 'verification',
        images,
        https: { bind: '127.0.0.1', port: httpsPort },
      }),
    );
    return {
      directory,
      images,
      tags,
      registryPort,
      execute,
      ops,
      opsResult,
      state,
      compose,
      digest,
      cleanup,
      variant: async (kind) => {
        const context = join(directory, kind);
        mkdirSync(context);
        if (kind === 'addition') {
          // A separately named persistent messaging worker for planning additions.
          writeFileSync(
            join(context, 'application.json'),
            JSON.stringify({
              name: 'ledger',
              persistence: true,
              messaging: true,
              exposure: false,
            }),
          );
          writeFileSync(
            join(context, 'Dockerfile'),
            `FROM ${images.wallet}\nCOPY --chown=bun:bun application.json /app/app/application.json\n`,
          );
          const tag = `127.0.0.1:${String(registryPort)}/ledger:addition`;
          await execute(['docker', 'build', '-t', tag, context]);
          tags.push(tag);
          return digest(tag);
        }
        if (kind === 'process' || kind === 'http') {
          const main = readFileSync('src/apps/user/main.ts', 'utf8');
          const fault =
            kind === 'process'
              ? "if (!existsSync('/tmp/operations-recover')) throw new Error('candidate startup fault');\n"
              : '';
          writeFileSync(
            join(context, 'main.ts'),
            "import { existsSync } from 'node:fs';\n" + fault + main,
          );
          writeFileSync(
            join(context, 'migration.sql'),
            `-- Up Migration\nCREATE TABLE candidate_marker (id integer);\n${kind === 'http' ? 'REVOKE SELECT ON users FROM user_runtime;\n' : ''}-- Down Migration\nDROP TABLE candidate_marker;\n`,
          );
          writeFileSync(
            join(context, 'Dockerfile'),
            `FROM ${images.user}\nCOPY --chown=bun:bun main.ts /app/app/main.ts\nCOPY --chown=bun:bun migration.sql /app/app/database/migrations/1990000000003_candidate.sql\n`,
          );
          const tag = `127.0.0.1:${String(registryPort)}/user:${kind}`;
          await execute(['docker', 'build', '-t', tag, context]);
          tags.push(tag);
          return digest(tag);
        }
        if (kind === 'incompatible') {
          writeFileSync(
            join(context, 'application.json'),
            JSON.stringify({
              name: 'user',
              persistence: false,
              messaging: true,
              exposure: true,
            }),
          );
          writeFileSync(
            join(context, 'Dockerfile'),
            `FROM ${images.user}\nCOPY --chown=bun:bun application.json /app/app/application.json\n`,
          );
          const tag = `127.0.0.1:${String(registryPort)}/user:incompatible`;
          await execute(['docker', 'build', '-t', tag, context]);
          tags.push(tag);
          return digest(tag);
        }
        const sql =
          kind === 'compatible'
            ? 'CREATE TABLE operations_marker (id integer);'
            : kind === 'failure'
              ? 'CREATE TABLE operations_partial (id integer); SELECT 1/0;'
              : 'CREATE TABLE operations_interrupted (id integer); SELECT pg_sleep(30);';
        writeFileSync(
          join(context, 'migration.sql'),
          `-- Up Migration\n${sql}\n-- Down Migration\nSELECT 1;\n`,
        );
        writeFileSync(
          join(context, 'Dockerfile'),
          `FROM ${kind !== 'compatible' ? (compatibleImage ?? images.user) : images.user}\nCOPY --chown=bun:bun migration.sql /app/app/database/migrations/${kind === 'compatible' ? '1990000000000' : kind === 'failure' ? '1990000000001' : '1990000000002'}_operations-${kind}.sql\n`,
        );
        const tag = `127.0.0.1:${String(registryPort)}/user:${kind}`;
        await execute(['docker', 'build', '-t', tag, context]);
        tags.push(tag);
        const image = await digest(tag);
        if (kind === 'compatible') compatibleImage = image;
        return image;
      },
      request: async (
        path: string,
        options: { method?: string; data?: unknown } = {},
      ) => {
        const result = await execute([
          'curl',
          '--silent',
          '--show-error',
          '--fail-with-body',
          '--cacert',
          join(secrets, 'tls.crt'),
          '-X',
          options.method ?? 'GET',
          ...(options.data
            ? [
                '-H',
                'Content-Type: application/json',
                '--data',
                JSON.stringify(options.data),
              ]
            : []),
          `https://127.0.0.1:${String(httpsPort)}${path}`,
        ]);
        return JSON.parse(result) as unknown;
      },
    };
  } catch (error) {
    return withCleanup(() => {
      throw error;
    }, [cleanup]);
  }
}
