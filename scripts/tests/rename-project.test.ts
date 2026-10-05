import { expect, test } from 'bun:test';
import { cp, mkdir, readFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, type Workspace } from './workspace-fixture';

const identity = [
  '--display-name=Acme Service',
  '--package-name=acme-service',
  '--author=Acme Engineering',
  '--owner=acme',
  '--repository=acme/service',
  '--contact=https://github.com/acme',
];

async function checkout(): Promise<Workspace> {
  const workspace = await createWorkspace();
  try {
    for (const directory of ['.github', 'docs']) {
      await mkdir(join(workspace.root, directory), { recursive: true });
      await cp(
        join(import.meta.dir, '../..', directory),
        join(workspace.root, directory),
        {
          recursive: true,
        },
      );
    }
    for (const args of [
      ['git', 'init', '--initial-branch=adopter'],
      ['git', 'config', 'user.name', 'Test Adopter'],
      ['git', 'config', 'user.email', 'adopter@example.test'],
      [
        'git',
        'remote',
        'add',
        'origin',
        'https://github.com/example/unchanged.git',
      ],
      ['git', 'add', '.'],
      ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'],
    ]) {
      const result = await workspace.run(args);
      expect(result.code, result.stderr).toBe(0);
    }
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

test('adopter previews exact identity edits without writing to the checkout', async () => {
  const workspace = await checkout();
  try {
    const preview = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...identity,
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('Acme Service');
    expect(preview.stdout).toContain('domain-driven-hexagon-scaffold');
    expect(preview.stdout).toContain('acme-service');
    expect(preview.stdout).toContain('README.md');
    expect(preview.stdout).toContain('preview');
    expect(
      (
        await workspace.run([
          'git',
          'status',
          '--porcelain',
          '--untracked-files=all',
        ])
      ).stdout,
    ).toBe('');
    expect(
      JSON.parse(await readFile(join(workspace.root, 'package.json'), 'utf8')),
    ).toMatchObject({
      name: 'domain-driven-hexagon-scaffold',
      license: 'MIT',
    });
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test('explicit application personalizes current identity and preserves Git, contracts and provenance', async () => {
  const workspace = await checkout();
  try {
    const config = await readFile(join(workspace.root, '.git/config'), 'utf8');
    const head = (await workspace.run(['git', 'rev-parse', 'HEAD'])).stdout;
    const preview = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...identity,
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    const planned = JSON.parse(preview.stdout) as {
      changes: { path: string; edits: { before: string; after: string }[] }[];
    };
    const originals = new Map(
      await Promise.all(
        planned.changes.map(
          async ({ path }) =>
            [path, await readFile(join(workspace.root, path), 'utf8')] as const,
        ),
      ),
    );
    const apply = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...identity,
      '--apply',
    ]);
    expect(apply.code, apply.stderr).toBe(0);
    const read = (path: string): Promise<string> =>
      readFile(join(workspace.root, path), 'utf8');
    expect(JSON.parse(await read('package.json'))).toMatchObject({
      name: 'acme-service',
      author: 'Acme Engineering',
      license: 'MIT',
      repository: 'https://github.com/acme/service',
      bugs: { url: 'https://github.com/acme/service/issues' },
    });
    expect(await read('bun.lock')).toContain('"name": "acme-service"');
    for (const path of ['README.md', 'README.pt-BR.md']) {
      const content = await read(path);
      expect(content.startsWith('# Acme Service\n')).toBe(true);
      expect(content).toContain('[Acme Service](#acme-service)');
      expect(content).toContain(
        'https://github.com/acme/service/actions/workflows/ci.yml',
      );
      expect(content).toContain(
        'https://github.com/Sairyss/domain-driven-hexagon',
      );
    }
    expect(await read('VISION.md')).toContain('# Acme Service Vision\n');
    expect(await read('VISION.md')).toContain(
      'Acme Service is an educational TypeScript starter',
    );
    expect(await read('.github/CODEOWNERS')).toContain('* @acme\n');
    for (const path of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'])
      expect(await read(path)).toContain(
        'Maintainer: [Acme Engineering](https://github.com/acme).',
      );
    expect(await read('SECURITY.md')).toContain(
      'https://github.com/acme/service/security/advisories/new',
    );
    expect(await read('.github/ISSUE_TEMPLATE/config.yml')).toContain(
      'https://github.com/acme/service/security/policy',
    );
    expect(await read('AGENTS.md')).toContain('`acme/service`');
    expect(await read('docs/agents/issue-tracker.md')).toContain(
      'https://github.com/acme/service/issues',
    );
    expect(JSON.parse(apply.stdout)).toMatchObject({
      mode: 'applied',
      changes: planned.changes,
    });
    const changed = (await workspace.run(['git', 'diff', '--name-only'])).stdout
      .trim()
      .split('\n');
    expect(changed.sort()).toEqual(
      planned.changes.map(({ path }) => path).sort(),
    );
    for (const { path, edits } of planned.changes) {
      const original = originals.get(path);
      if (original === undefined) throw new Error(`Missing original: ${path}`);
      // Every byte written must have been reported in the preview.
      let expected = original;
      for (const { before, after } of edits)
        expected = expected.replace(before, after);
      expect(await read(path)).toBe(expected);
    }
    expect(await read('.git/config')).toBe(config);
    expect((await workspace.run(['git', 'rev-parse', 'HEAD'])).stdout).toBe(
      head,
    );
    expect(
      (await workspace.run(['git', 'branch', '--show-current'])).stdout.trim(),
    ).toBe('adopter');
    expect(
      (
        await workspace.run([
          'git',
          'ls-files',
          '--others',
          '--exclude-standard',
        ])
      ).stdout,
    ).toBe('');
    expect(changed).not.toContain('LICENSE');
    expect(changed).not.toContain('THIRD_PARTY_NOTICES.md');
    expect(
      changed.some(
        (path) => path.startsWith('src/') || path.startsWith('docs/adr/'),
      ),
    ).toBe(false);
    const repeated = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...identity,
      '--apply',
    ]);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual({
      mode: 'applied',
      changes: [],
    });
    const install = await workspace.run([
      process.execPath,
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
    ]);
    expect(install.code, install.stderr).toBe(0);
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test('invalid arguments and drifted ownership fail before any identity edits', async () => {
  const workspace = await checkout();
  try {
    for (const args of [
      [],
      [...identity, '--unknown'],
      identity.map((arg) =>
        arg.startsWith('--owner=') ? '--owner=bad/owner/extra' : arg,
      ),
      ...[
        'https://github.com:bad',
        'https://github.com:99999',
        'https://user@',
      ].map((contact) =>
        identity.map((arg) =>
          arg.startsWith('--contact=') ? `--contact=${contact}` : arg,
        ),
      ),
    ]) {
      const result = await workspace.run([
        process.execPath,
        'run',
        'rename',
        '--',
        '--apply',
        ...args,
      ]);
      expect(result.code).not.toBe(0);
      expect(
        (
          await workspace.run([
            'git',
            'status',
            '--porcelain',
            '--untracked-files=all',
          ])
        ).stdout,
      ).toBe('');
    }
    await Bun.write(
      join(workspace.root, '.github/CODEOWNERS'),
      '* @custom-owner\n',
    );
    const result = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...identity,
      '--apply',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('.github/CODEOWNERS');
    expect(
      (await workspace.run(['git', 'diff', '--name-only'])).stdout.trim(),
    ).toBe('.github/CODEOWNERS');
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test('linked identity directories are rejected without changing their targets', async () => {
  const workspace = await checkout();
  try {
    await mkdir(join(workspace.root, '.context'));
    await rename(
      join(workspace.root, '.github'),
      join(workspace.root, '.context/github'),
    );
    await symlink(
      join(workspace.root, '.context/github'),
      join(workspace.root, '.github'),
      'dir',
    );
    const before = (await workspace.run(['git', 'diff'])).stdout;
    for (const mode of [[], ['--apply']]) {
      const result = await workspace.run([
        process.execPath,
        'run',
        'rename',
        '--',
        ...identity,
        ...mode,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('regular file inside this checkout');
      expect((await workspace.run(['git', 'diff'])).stdout).toBe(before);
      expect(
        await readFile(
          join(workspace.root, '.context/github/CODEOWNERS'),
          'utf8',
        ),
      ).toContain('* @danilomartinelli');
    }
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test('organization adopter assigns current ownership to a GitHub team', async () => {
  const workspace = await checkout();
  try {
    const teamIdentity = identity.map((arg) =>
      arg.startsWith('--owner=') ? '--owner=acme/maintainers' : arg,
    );
    const preview = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...teamIdentity,
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('@acme/maintainers');
    const apply = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...teamIdentity,
      '--apply',
    ]);
    expect(apply.code, apply.stderr).toBe(0);
    expect(
      await readFile(join(workspace.root, '.github/CODEOWNERS'), 'utf8'),
    ).toContain('* @acme/maintainers\n');
    const repeated = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...teamIdentity,
    ]);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual({
      mode: 'preview',
      changes: [],
    });
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test('adopter metadata outside the managed identity fields is preserved', async () => {
  const workspace = await checkout();
  try {
    const path = join(workspace.root, 'scaffold.identity.json');
    const current: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof current !== 'object' || current === null)
      throw new Error('Invalid fixture identity');
    await Bun.write(
      path,
      JSON.stringify(
        { ...current, historicalRepository: 'example/original' },
        null,
        2,
      ) + '\n',
    );
    const preview = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...identity,
    ]);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).not.toContain('historicalRepository');
    const apply = await workspace.run([
      process.execPath,
      'run',
      'rename',
      '--',
      ...identity,
      '--apply',
    ]);
    expect(apply.code, apply.stderr).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      displayName: 'Acme Service',
      historicalRepository: 'example/original',
    });
  } finally {
    await workspace.cleanup();
  }
}, 30_000);

test.each([
  'https://example.com:8443/contact?team=core#help',
  'mailto:team@example.com',
])(
  'valid contact %s remains usable through preview and application',
  async (contact) => {
    const workspace = await checkout();
    try {
      const args = identity.map((arg) =>
        arg.startsWith('--contact=') ? `--contact=${contact}` : arg,
      );
      for (const flags of [[], ['--apply']]) {
        const result = await workspace.run([
          process.execPath,
          'run',
          'rename',
          '--',
          ...args,
          ...flags,
        ]);
        expect(result.code, result.stderr).toBe(0);
      }
      const manifest = JSON.parse(
        await readFile(join(workspace.root, 'scaffold.identity.json'), 'utf8'),
      ) as unknown;
      expect(manifest).toMatchObject({ contact });
      expect(
        await readFile(join(workspace.root, 'CONTRIBUTING.md'), 'utf8'),
      ).toContain(`](${contact})`);
    } finally {
      await workspace.cleanup();
    }
  },
);
