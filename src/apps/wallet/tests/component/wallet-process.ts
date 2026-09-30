import { afterAll, afterEach, beforeAll } from 'bun:test';
import type { Subprocess } from 'bun';
import pg from 'pg';
import { assertTestEnvironment } from '../../../../../database/environment';

const root = new URL('../../../../../', import.meta.url).pathname;
let wallet: Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
let output = '';
let owner: pg.Client | undefined;

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** Wallet's database with the given role; the process itself only knows the runtime role. */
export function walletDatabase(role: 'runtime' | 'owner'): pg.ClientConfig {
  const credential = role === 'owner' ? 'WALLET_DB_MIGRATION_' : 'WALLET_DB_';
  return {
    host: setting('WALLET_DB_HOST'),
    port: Number(setting('WALLET_DB_PORT')),
    database: setting('WALLET_DB_NAME'),
    user: setting(`${credential}USERNAME`),
    password: setting(`${credential}PASSWORD`),
  };
}

export function walletUrl(): string {
  return `http://127.0.0.1:${setting('WALLET_HTTP_PORT')}`;
}

/** Owner connection for fixtures and cleanup; available after the preload starts Wallet. */
export function ownerDatabase(): pg.Client {
  if (!owner) throw new Error('Wallet database has not been opened.');
  return owner;
}

async function cleanDatabase(): Promise<void> {
  assertTestEnvironment();
  await owner?.query('TRUNCATE wallets');
}

/**
 * Only Wallet settings reach the process: no User or legacy database, no
 * broker and no migration owner. Starting proves none of them is required.
 */
function walletEnvironment(): Record<string, string> {
  const excluded = /^(DB_|RABBITMQ_|USER_HTTP_PORT$|WALLET_DB_MIGRATION_)/;
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
        `Wallet exited with ${String(process.exitCode)}:\n${output}`,
      );
    try {
      await fetch(`${walletUrl()}/v1/wallets/by-user/startup-probe`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Wallet did not listen within 20 seconds:\n${output}`);
}

async function stopWallet(): Promise<void> {
  if (!wallet) return;
  const running = wallet;
  wallet = undefined;
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

beforeAll(async () => {
  try {
    owner = new pg.Client(walletDatabase('owner'));
    await owner.connect();
    await cleanDatabase();
    wallet = Bun.spawn([process.execPath, 'src/apps/wallet/main.ts'], {
      cwd: root,
      env: walletEnvironment(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void collect(wallet.stdout);
    void collect(wallet.stderr);
    await waitUntilListening(wallet);
  } catch (error) {
    await stopWallet();
    await owner?.end();
    owner = undefined;
    throw error;
  }
});

afterEach(cleanDatabase);

afterAll(async () => {
  await stopWallet();
  await owner?.end();
  owner = undefined;
});
