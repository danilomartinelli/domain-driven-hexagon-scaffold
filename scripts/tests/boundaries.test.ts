import { expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace } from './workspace-fixture';

const findUsers = 'src/modules/user/queries/find-users';
const wallet = 'src/apps/wallet';

/** Each import is legal TypeScript that only the architecture rules reject. */
const violations = [
  {
    rule: 'core-is-context-independent',
    file: 'src/modules/user/application/find-users.ts',
    source: "import type { Logger } from '@nestjs/common';",
  },
  {
    rule: 'no-input-adapter-to-persistence-deps',
    file: `${findUsers}/find-users.graphql-resolver.ts`,
    source: "import type { UserModel } from '../../database/user.schema';",
  },
  {
    rule: 'no-input-adapter-to-persistence-deps',
    file: `${findUsers}/find-users.query-handler.ts`,
    source: "import type { UserModel } from '../../database/user.schema';",
  },
  {
    rule: 'no-command-query-to-api-deps',
    file: `${findUsers}/find-users.query-handler.ts`,
    source:
      "import type { FindUsersRequestDto } from './find-users.request.dto';",
  },
  {
    rule: 'no-circular',
    file: 'src/modules/user/application/user-read.port.ts',
    source: "import type { FindUsers } from './find-users';",
  },
  {
    rule: 'core-is-context-independent',
    file: `${wallet}/application/find-wallet-by-user.ts`,
    source: "import type { DatabasePool } from 'slonik';",
  },
  {
    rule: 'no-input-adapter-to-persistence-deps',
    file: `${wallet}/queries/find-wallet-by-user/find-wallet-by-user.graphql-resolver.ts`,
    source: "import type { walletSchema } from '../../database/wallet.schema';",
  },
  {
    rule: 'apps-are-independent',
    file: `${wallet}/application/wallet-read.port.ts`,
    source:
      "import type { UserSummary } from '../../../modules/user/application/user-read.port';",
  },
  {
    rule: 'app-runtime-excludes-tooling',
    file: `${wallet}/configs/environment.ts`,
    source:
      "import type { EnvironmentManifest } from '../../../../database/environment';",
  },
  {
    rule: 'app-implementation-is-private',
    file: 'src/modules/wallet/wallet.module.ts',
    source:
      "import type { WalletSummary } from '../../apps/wallet/application/wallet-read.port';",
  },
];

test('architecture rules reject representative layer violations and a cycle', async () => {
  const workspace = await createWorkspace();
  try {
    // The same command as the workspace:boundaries target, so scopes cannot drift.
    const project = (await Bun.file(
      join(workspace.root, 'project.json'),
    ).json()) as { targets: { boundaries: { options: { command: string } } } };
    const boundaries = () =>
      workspace.run(['sh', '-c', project.targets.boundaries.options.command]);
    // The unmodified graph, with its legal port/adapter/composition edges, passes.
    const clean = await boundaries();
    expect(clean.code, clean.stdout + clean.stderr).toBe(0);

    for (const { rule, file, source } of violations) {
      const path = join(workspace.root, file);
      const original = await readFile(path, 'utf8');
      await appendFile(path, `\n${source}\n`);
      const rejected = await boundaries();
      await writeFile(path, original);
      expect(rejected.code, `${rule}: ${file}`).not.toBe(0);
      // A cycle is reported from either member, so match the rule and the file.
      expect(rejected.stdout).toContain(`error ${rule}: `);
      expect(rejected.stdout).toContain(file);
    }
  } finally {
    await workspace.cleanup();
  }
}, 60_000);
