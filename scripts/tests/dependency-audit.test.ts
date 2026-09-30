import { expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, type CommandResult } from '../lib/command';
import { isolatedEnvironment } from './workspace-fixture';

const sourceRoot = join(import.meta.dir, '../..');
const auditScript = join(sourceRoot, 'scripts/audit-changed.ts');

async function git(root: string, ...args: string[]): Promise<void> {
  const result = await runCommand(['git', ...args], {
    cwd: root,
    env: isolatedEnvironment(),
  });
  if (result.code !== 0) throw new Error(result.stderr);
}

async function withRepository(
  action: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ddh-audit-'));
  try {
    await copyFile(
      join(sourceRoot, 'package.json'),
      join(root, 'package.json'),
    );
    await copyFile(join(sourceRoot, 'bun.lock'), join(root, 'bun.lock'));
    await git(root, 'init', '--initial-branch=master');
    await git(root, 'config', 'user.name', 'Audit test');
    await git(root, 'config', 'user.email', 'audit@example.invalid');
    await git(root, 'config', 'core.hooksPath', '/dev/null');
    await git(root, 'add', '.');
    await git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline');
    await git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function audit(
  root: string,
  args: string[] = [],
  registry = 'http://127.0.0.1:1',
): Promise<CommandResult> {
  return runCommand([process.execPath, auditScript, ...args], {
    cwd: root,
    env: { ...isolatedEnvironment(), npm_config_registry: registry },
  });
}

test('non-dependency changes skip the registry in both branch and staged modes', async () => {
  await withRepository(async (root) => {
    await writeFile(join(root, 'README.md'), 'documentation change');
    await git(root, 'add', 'README.md');
    for (const args of [[], ['--staged']]) {
      const result = await audit(root, args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('[audit:skipped]');
    }
  });
});

test('changed lockfiles and workspace manifests trigger a fresh real Bun audit across staged, committed and untracked changes', async () => {
  const requests: unknown[] = [];
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe(
        '/-/npm/v1/security/advisories/bulk',
      );
      const body = new Uint8Array(await request.arrayBuffer());
      const json =
        request.headers.get('content-encoding') === 'gzip'
          ? Bun.gunzipSync(body)
          : body;
      const payload: unknown = JSON.parse(new TextDecoder().decode(json));
      requests.push(payload);
      return Response.json({});
    },
  });
  try {
    await withRepository(async (root) => {
      const lockfile = Bun.file(join(root, 'bun.lock'));
      await Bun.write(lockfile, (await lockfile.text()) + '\n');
      await git(root, 'add', 'bun.lock');
      for (let invocation = 0; invocation < 2; invocation++) {
        const result = await audit(root, ['--staged'], registry.url.toString());
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('[audit:clean]');
      }
      await git(
        root,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'lockfile change',
      );
      const committed = await audit(root, [], registry.url.toString());
      expect(committed.code, committed.stderr).toBe(0);
      expect(committed.stdout).toContain('[audit:clean]');
      // A fresh comparison base isolates untracked workspace manifests from the committed lock change.
      await mkdir(join(root, 'packages/new'), { recursive: true });
      await writeFile(
        join(root, 'packages/new/package.json'),
        '{"private":true}',
      );
      const untracked = await audit(
        root,
        ['--base', 'HEAD'],
        registry.url.toString(),
      );
      expect(untracked.code, untracked.stderr).toBe(0);
      expect(untracked.stdout).toContain('packages/new/package.json');
      expect(requests).toHaveLength(4);
      expect(requests[0]).toHaveProperty('nx');
      expect(requests[0]).toHaveProperty('slonik');
    });
  } finally {
    await registry.stop(true);
  }
});

test('vulnerabilities fail with status 1 while registry failures are unavailable with status 2', async () => {
  let unavailable = false;
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      if (unavailable)
        return Response.json({ error: 'offline' }, { status: 503 });
      return Response.json({
        'smol-toml': [
          {
            id: 123,
            title: 'Fixture advisory',
            url: 'https://example.invalid/advisory',
            severity: 'high',
            vulnerable_versions: '<=1.9.0',
            cwe: [],
            cvss: { score: 7.5, vectorString: null },
          },
        ],
      });
    },
  });
  try {
    await withRepository(async (root) => {
      const manifest = Bun.file(join(root, 'package.json'));
      await Bun.write(manifest, (await manifest.text()) + '\n');
      const vulnerable = await audit(root, [], registry.url.toString());
      expect(vulnerable.code).toBe(1);
      expect(vulnerable.stderr).toContain('[audit:vulnerable]');
      expect(vulnerable.stderr).toContain('Fixture advisory');
      unavailable = true;
      const failed = await audit(root, [], registry.url.toString());
      expect(failed.code).toBe(2);
      expect(failed.stderr).toContain('[audit:unavailable]');
      expect(failed.stdout).not.toContain('[audit:clean]');
    });
  } finally {
    await registry.stop(true);
  }
}, 60_000);

test('an unavailable comparison base and mixed staged dependency content cannot become successful audits', async () => {
  await withRepository(async (root) => {
    const noBase = await audit(root, ['--base', 'missing-ref']);
    expect(noBase.code).toBe(2);
    expect(noBase.stderr).toContain('[audit:unavailable]');
    const manifest = Bun.file(join(root, 'package.json'));
    await Bun.write(manifest, (await manifest.text()) + '\n');
    await git(root, 'add', 'package.json');
    await Bun.write(manifest, (await manifest.text()) + '\n');
    const mixed = await audit(root, ['--staged']);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain('differ from the index');
  });
});

test('a staged lockfile deletion cannot be validated using an untracked working copy', async () => {
  await withRepository(async (root) => {
    await git(root, 'rm', '--cached', 'bun.lock');
    const result = await audit(root, ['--staged']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('differ from the index');
  });
});
