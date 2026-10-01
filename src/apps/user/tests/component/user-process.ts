import { afterAll, afterEach, beforeAll } from 'bun:test';
import type { Subprocess } from 'bun';
import pg from 'pg';
import { assertTestEnvironment } from '../../../../../database/environment';
import request from 'supertest';
import { withCleanup } from '../../../../../scripts/tests/cleanup';

const root = new URL('../../../../../', import.meta.url).pathname;
let user: Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
let output = '';
let owner: pg.Client | undefined;

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** User's database with the given role; the process itself only knows the runtime role. */
export function userDatabase(role: 'runtime' | 'owner'): pg.ClientConfig {
  const credential = role === 'owner' ? 'USER_DB_MIGRATION_' : 'USER_DB_';
  return {
    host: setting('USER_DB_HOST'),
    port: Number(setting('USER_DB_PORT')),
    database: setting('USER_DB_NAME'),
    user: setting(`${credential}USERNAME`),
    password: setting(`${credential}PASSWORD`),
  };
}

export function userUrl(): string {
  return `http://127.0.0.1:${setting('USER_HTTP_PORT')}`;
}

export function userOutput(): string {
  return output;
}

/** Owner connection for fixtures and cleanup; available after the preload starts User. */
export function ownerDatabase(): pg.Client {
  if (!owner) throw new Error('User database has not been opened.');
  return owner;
}

async function cleanDatabase(): Promise<void> {
  assertTestEnvironment();
  await owner?.query('TRUNCATE users, user_outbox');
}

/**
 * User knows only its runtime database settings, with no broker, sibling
 * database, environment manifest or migration owner credentials.
 */
export function userEnvironment(): Record<string, string> {
  const excluded = /^(DB_|WALLET_|RABBITMQ_|USER_DB_MIGRATION_|DDH_)/;
  const env: Record<string, string> = { NO_COLOR: '1' };
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !excluded.test(name)) env[name] = value;
  return env;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) output += decoder.decode(chunk);
}

async function waitUntilListening(process: Subprocess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null)
      throw new Error(
        `User exited with ${String(process.exitCode)}:\n${output}`,
      );
    try {
      await fetch(`${userUrl()}/v1/users`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`User did not listen within 20 seconds:\n${output}`);
}

export async function stopUser(): Promise<void> {
  if (!user) return;
  const running = user;
  user = undefined;
  running.kill('SIGTERM');
  const stopped = await Promise.race([
    running.exited,
    Bun.sleep(10_000).then(() => false as const),
  ]);
  if (stopped === false) {
    running.kill('SIGKILL');
    await running.exited;
  }
}

export async function startUser(
  overrides: Record<string, string> = {},
): Promise<void> {
  if (user) throw new Error('User is already running');
  output = '';
  user = Bun.spawn([process.execPath, 'src/apps/user/main.ts'], {
    cwd: root,
    env: { ...userEnvironment(), ...overrides },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void collect(user.stdout);
  void collect(user.stderr);
  await waitUntilListening(user);
}

beforeAll(async () => {
  try {
    owner = new pg.Client(userDatabase('owner'));
    await owner.connect();
    await cleanDatabase();
    await startUser();
  } catch (error) {
    await withCleanup(() => {
      throw error;
    }, [closeResources]);
  }
});

afterEach(cleanDatabase);

async function closeResources(): Promise<void> {
  await withCleanup(stopUser, [
    async () => {
      const connection = owner;
      owner = undefined;
      await connection?.end();
    },
  ]);
}

afterAll(closeResources);

export function getHttpServer(): ReturnType<typeof request> {
  return request(userUrl());
}
