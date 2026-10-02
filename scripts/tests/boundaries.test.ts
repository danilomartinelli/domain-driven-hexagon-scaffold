import { expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace } from './workspace-fixture';

const findUsers = 'src/apps/user/queries/find-users';
const wallet = 'src/apps/wallet';

/** Each import is legal TypeScript that only the architecture rules reject. */
const violations = [
  ...[
    'src/apps/user/domain/user.entity.ts',
    'src/apps/wallet/application/create-wallet.ts',
  ].flatMap((file) =>
    [
      "import type { Logger } from '@nestjs/common';",
      "import type { DatabasePool } from 'slonik';",
      "import type { Channel } from 'amqplib';",
      "import type { RequestContextService } from '@starter/nest-support/context';",
      "import type { AsyncLocalStorage } from 'node:async_hooks';",
    ].map((source) => ({ rule: 'core-is-context-independent', file, source })),
  ),
  {
    rule: 'core-is-context-independent',
    file: 'src/apps/user/application/find-users.ts',
    source: "export type { UserResponseDto } from '../dtos/user.response.dto';",
  },
  {
    rule: 'core-is-context-independent',
    file: 'src/apps/wallet/domain/wallet.entity.ts',
    source:
      "import type { SlonikWalletReadAdapter } from '../database/wallet-read.adapter';",
  },
  {
    rule: 'no-domain-to-app-deps',
    file: 'src/apps/wallet/domain/wallet.entity.ts',
    source:
      "import type { WalletReadPort } from '../application/wallet-read.port';",
  },
  {
    // User and Wallet already consume this entry point: the re-export must not
    // smuggle ambient transaction context into either application's core.
    rule: 'core-is-context-independent',
    file: 'src/packages/core/domain.ts',
    source:
      "export { RequestContextService } from '@starter/nest-support/context';",
  },
  {
    // The real User composition imports context, forming app -> shared -> sibling.
    rule: 'app-implementation-is-private',
    file: 'src/packages/nest-support/context.ts',
    source:
      "export type { WalletSummary } from '../../apps/wallet/application/wallet-read.port';",
  },
  {
    rule: 'not-to-test',
    file: 'src/apps/user/user.module.ts',
    source:
      "import type { MemoryUserReads } from './tests/unit/fixtures/memory-user-reads';",
  },
  {
    rule: 'not-to-test',
    file: 'src/apps/user/user.module.ts',
    source: "import type { TestContext } from '@tests/test-utils/TestContext';",
  },
  {
    rule: 'entrypoint-boundary-from-app',
    file: 'src/apps/user/application/find-users.ts',
    source:
      "import type { Entity } from '../../../packages/core/lib/ddd/entity.base';",
  },
  {
    rule: 'not-to-unresolvable',
    file: 'src/apps/user/application/find-users.ts',
    source: "import type { Entity } from '@starter/core/lib/ddd/entity.base';",
  },
  {
    rule: 'core-is-context-independent',
    file: 'src/apps/user/commands/create-user/create-user.command.ts',
    source: "import type { Logger } from '@nestjs/common';",
  },
  {
    rule: 'core-is-context-independent',
    file: 'src/apps/user/application/create-user.ts',
    source: "import type { DatabasePool } from 'slonik';",
  },
  {
    rule: 'no-input-adapter-to-persistence-deps',
    file: 'src/apps/user/queries/find-users/find-users.graphql-resolver.ts',
    source: "import type { UserModel } from '../../database/user.schema';",
  },
  {
    rule: 'apps-are-independent',
    file: 'src/apps/user/application/user-read.port.ts',
    source:
      "import type { WalletSummary } from '../../wallet/application/wallet-read.port';",
  },
  {
    rule: 'apps-are-independent',
    file: 'src/apps/wallet/application/wallet-read.port.ts',
    source:
      "import type { UserSummary } from '../../user/application/user-read.port';",
  },
  {
    rule: 'app-runtime-excludes-tooling',
    file: 'src/apps/user/configs/environment.ts',
    source:
      "import type { EnvironmentManifest } from '../../../../database/environment';",
  },
  {
    rule: 'integration-contract-is-independent',
    file: 'src/packages/integration-contracts/user-created.ts',
    source:
      "import type { UserCreatedDomainEvent } from '../../apps/user/domain/events/user-created.domain-event';",
  },
  {
    rule: 'no-input-adapter-to-persistence-deps',
    file: `${wallet}/messaging/user-created-consumer.ts`,
    source: "import type { walletSchema } from '../database/wallet.schema';",
  },
  {
    rule: 'core-is-context-independent',
    file: 'src/apps/user/application/find-users.ts',
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
    file: 'src/apps/user/application/user-read.port.ts',
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
      "import type { UserSummary } from '../../../apps/user/application/user-read.port';",
  },
  {
    rule: 'app-runtime-excludes-tooling',
    file: `${wallet}/configs/environment.ts`,
    source:
      "import type { EnvironmentManifest } from '../../../../database/environment';",
  },
  {
    rule: 'app-runtime-excludes-tooling',
    file: `${wallet}/configs/environment.ts`,
    source: "import { withCleanup } from '../../../../scripts/tests/cleanup';",
  },
  {
    rule: 'app-implementation-is-private',
    file: 'tests/test-utils/ApiClient.ts',
    source:
      "import type { WalletSummary } from '../../src/apps/wallet/application/wallet-read.port';",
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
    const restored = await boundaries();
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
  } finally {
    await workspace.cleanup();
  }
}, 60_000);

test('Nx ownership and cycles reject declared edges after warming the boundary cache', async () => {
  const workspace = await createWorkspace();
  try {
    const check = () => workspace.run(['bun', 'run', 'lint:boundaries']);
    const clean = await check();
    expect(clean.code, clean.stdout + clean.stderr).toBe(0);
    for (const [file, dependency, rule] of [
      ['project.json', 'user', 'nx-app-implementation-is-private'],
      ['scripts/project.json', 'user', 'nx-app-implementation-is-private'],
      [
        'src/apps/user/project.json',
        'wallet',
        'nx-app-implementation-is-private',
      ],
      ['src/packages/example/project.json', 'user', 'nx-shared-is-technical'],
      [
        'src/packages/core/project.json',
        'nest-support',
        'nx-core-is-independent',
      ],
      [
        'src/packages/integration-contracts/project.json',
        'core',
        'nx-contracts-are-independent',
      ],
      // test-runner already depends on database; no source-file cycle is needed.
      ['database/project.json', 'test-runner', 'nx-no-circular'],
    ]) {
      const path = join(workspace.root, file);
      const original = await readFile(path, 'utf8');
      const project = JSON.parse(original) as {
        implicitDependencies?: string[];
      };
      project.implicitDependencies = [
        ...(project.implicitDependencies ?? []),
        dependency,
      ];
      await Bun.write(path, JSON.stringify(project));
      const result = await check();
      await writeFile(path, original);
      expect(result.code, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(rule);
    }
    const restored = await check();
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
  } finally {
    await workspace.cleanup();
  }
}, 60_000);
