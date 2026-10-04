import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from '../lib/command';
import { isolatedEnvironment } from './workspace-fixture';

const root = join(import.meta.dir, '../..');

const manifestSchema = z.object({ scripts: z.record(z.string(), z.string()) });

const targetSchema = z.object({
  cache: z.boolean().optional(),
  inputs: z.array(z.unknown()).optional(),
  options: z.object({ command: z.string().optional() }).optional(),
});

const graphSchema = z.object({
  graph: z.object({
    nodes: z.record(
      z.string(),
      z.object({
        data: z.object({
          tags: z.array(z.string()).optional(),
          targets: z.record(z.string(), targetSchema).optional(),
        }),
      }),
    ),
  }),
});

async function readPackageScripts(): Promise<Record<string, string>> {
  return manifestSchema.parse(await Bun.file(join(root, 'package.json')).json())
    .scripts;
}

let projects:
  Promise<z.infer<typeof graphSchema>['graph']['nodes']> | undefined;

/**
 * Resolved targets, including target defaults, as Nx executes them. Computed
 * once with temporary Nx data so the checkout's graph and caches stay untouched.
 */
function resolvedProjects() {
  projects ??= (async () => {
    const data = await mkdtemp(join(tmpdir(), 'ddh-workflow-nx-'));
    try {
      const result = await runCommand(
        [process.execPath, 'run', 'nx', 'graph', '--print'],
        {
          cwd: root,
          env: {
            ...isolatedEnvironment(),
            NX_WORKSPACE_DATA_DIRECTORY: data,
            NX_CACHE_DIRECTORY: join(data, 'cache'),
          },
          timeout: 30_000,
          maxOutput: 4_000_000,
        },
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      return graphSchema.parse(JSON.parse(result.stdout)).graph.nodes;
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  })();
  return projects;
}

/** Package scripts a command runs through `bun run <script>`, excluding the Nx wrapper. */
function invokedScripts(
  packageScripts: Record<string, string>,
  command: string,
): string[] {
  return [...command.matchAll(/\bbun run ([\w:-]+)/g)]
    .map(([, script]) => script)
    .filter((script) => script !== 'nx' && script in packageScripts);
}

/** Package scripts reached through `bun run <script>` chains. */
function reachable(
  packageScripts: Record<string, string>,
  name: string,
): string[] {
  const seen = new Set<string>();
  const visit = (script: string) => {
    if (seen.has(script)) return;
    seen.add(script);
    for (const next of invokedScripts(
      packageScripts,
      packageScripts[script] ?? '',
    ))
      visit(next);
  };
  visit(name);
  return [...seen];
}

test('make aliases delegate to package scripts whose full gate reaches every required suite', async () => {
  const dryRun = await runCommand(
    ['make', '-n', 'dev', 'test', 'check', 'down'],
    {
      cwd: root,
      env: { ...isolatedEnvironment(), MAKEFLAGS: '' },
    },
  );
  expect(dryRun.code, dryRun.stderr).toBe(0);
  expect(dryRun.stdout.trim().split('\n')).toEqual([
    'bun run dev',
    'bun run test:e2e',
    'bun run check:full',
    'bun run dev:down',
  ]);

  const packageScripts = await readPackageScripts();
  // Environment actions run through their uncached infrastructure targets.
  expect(packageScripts.dev).toBe(
    'bun --no-env-file scripts/environment-cli.ts dev',
  );
  expect(packageScripts['dev:down']).toBe(
    'bun --no-env-file scripts/environment-cli.ts down --environment=development',
  );
  const infrastructure = (await resolvedProjects()).infrastructure.data.targets;
  for (const action of ['dev', 'down']) {
    expect(infrastructure?.[action]?.cache).toBe(false);
    expect(infrastructure?.[action]?.options?.command).toBe(
      `bun --no-env-file scripts/environment-cli.ts --nx ${action}`,
    );
  }
  expect(packageScripts['test:e2e']).toBe('bun run nx run e2e:e2e');

  const fast = reachable(packageScripts, 'check');
  for (const suite of [
    'format:check',
    'lint',
    'typecheck',
    'lint:boundaries',
    'test:unit',
    'check:workspace',
    'check:docs',
  ])
    expect(fast, suite).toContain(suite);
  const full = reachable(packageScripts, 'check:full');
  for (const suite of [
    ...fast,
    'audit:changed',
    'test:tooling',
    'test:e2e',
    'test:component',
    'test:distribution',
  ])
    expect(full, suite).toContain(suite);
}, 60_000);

test('only deterministic checks are cacheable; live and provisioning targets always execute', async () => {
  const deterministic = [
    'lint',
    'typecheck',
    'test',
    'format-check',
    'boundaries',
  ];
  const cached: string[] = [];
  for (const [project, { data }] of Object.entries(await resolvedProjects())) {
    for (const [name, target] of Object.entries(data.targets ?? {})) {
      const command = target.options?.command ?? '';
      // Provisioning, live suites, migrations, replay, serving and artifacts.
      if (
        /with-test-database|environment-cli|--preload|migrate|seed|failure-queue|distribute|\brun start\b|main\.ts/.test(
          command,
        )
      )
        expect(target.cache, `${project}:${name}`).toBe(false);
      if (target.cache !== true) continue;
      cached.push(`${project}:${name}`);
      expect(deterministic, `${project}:${name}`).toContain(name);
      // Both named inputs include the Bun runtime and shared tool configuration.
      expect(
        target.inputs?.some(
          (input) => input === 'default' || input === 'workspaceSources',
        ),
        `${project}:${name}`,
      ).toBe(true);
    }
  }
  expect(cached).toContain('workspace:format-check');
  expect(cached).toContain('workspace:boundaries');
  const nx = z
    .object({ namedInputs: z.record(z.string(), z.array(z.unknown())) })
    .parse(await Bun.file(join(root, 'nx.json')).json());
  expect(nx.namedInputs.default).toContain('sharedGlobals');
  expect(nx.namedInputs.workspaceSources).toContain('sharedGlobals');
  expect(nx.namedInputs.sharedGlobals).toContain(
    '{workspaceRoot}/tooling/config/**/*',
  );
  expect(nx.namedInputs.sharedGlobals).toContainEqual({
    runtime: 'bun --version',
  });
}, 60_000);

type Projects = Awaited<ReturnType<typeof resolvedProjects>>;

/** Test files a target runs, following delegated Nx targets and package scripts. */
function targetTestFiles(
  projects: Projects,
  packageScripts: Record<string, string>,
  project: string,
  target: string,
): string[] {
  let command =
    projects[project].data.targets?.[target]?.options?.command ?? '';
  const [script] = invokedScripts(packageScripts, command);
  if (script) command = packageScripts[script];
  const delegated = /\bnx run ([\w-]+):([\w-]+)/.exec(command);
  if (delegated)
    return targetTestFiles(
      projects,
      packageScripts,
      delegated[1],
      delegated[2],
    );
  return command
    .split(/\s+/)
    .filter((part) => part.startsWith('./'))
    .flatMap((path) => {
      const pattern = path.endsWith('.ts') ? path : `${path}/**/*.test.ts`;
      return [...new Bun.Glob(pattern.slice(2)).scanSync({ cwd: root })];
    })
    .filter((file) => file.endsWith('.test.ts'));
}

test('required native, component, system and distribution suites are not empty', async () => {
  const projects = await resolvedProjects();
  const packageScripts = await readPackageScripts();
  const native = Object.entries(projects)
    .filter(([, { data }]) =>
      data.tags?.some((tag) =>
        ['type:app', 'type:core', 'type:contracts'].includes(tag),
      ),
    )
    .map(([project]) => project)
    .concat('e2e');
  for (const project of ['user', 'wallet', 'core', 'integration-contracts'])
    expect(native).toContain(project);
  for (const project of native) {
    const target = projects[project].data.targets?.test;
    expect(target?.cache, project).toBe(true);
    expect(target?.options?.command, project).toMatch(/^bun test /);
    expect(
      targetTestFiles(projects, packageScripts, project, 'test'),
      project,
    ).not.toEqual([]);
  }
  expect(targetTestFiles(projects, packageScripts, 'e2e', 'test')).toContain(
    'tests/compatibility/contracts.test.ts',
  );

  // run-many silently skips a missing target, so every application and the
  // remaining live suites must declare theirs.
  const applications = Object.entries(projects)
    .filter(([, { data }]) => data.tags?.includes('type:app'))
    .map(([project]) => project);
  for (const app of ['user', 'wallet']) expect(applications).toContain(app);
  for (const [project, target] of [
    ...applications.flatMap((app) => [
      [app, 'test-component'],
      [app, 'test-distribution'],
    ]),
    ['generators', 'test-component'],
    ['e2e', 'e2e'],
    ['test-runner', 'test-live'],
  ]) {
    expect(projects[project].data.targets?.[target]?.cache, target).toBe(false);
    expect(
      targetTestFiles(projects, packageScripts, project, target),
      `${project}:${target}`,
    ).not.toEqual([]);
  }
}, 60_000);

test('editor tasks invoke existing package scripts', async () => {
  const tasks = z
    .object({ tasks: z.array(z.object({ command: z.string() })) })
    .parse(await Bun.file(join(root, '.vscode/tasks.json')).json()).tasks;
  const packageScripts = await readPackageScripts();
  for (const { command } of tasks) {
    const script = /^bun run ([\w:-]+)$/.exec(command)?.[1] ?? '';
    expect(Object.keys(packageScripts), command).toContain(script);
  }
});
