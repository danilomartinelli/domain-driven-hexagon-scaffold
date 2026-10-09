import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../lib/command';
import { operationsCompose } from '../lib/operations-compose';
import { stateSchema, type InstallationState } from '../lib/operations-config';
import {
  deploymentRecordSchema,
  type DeploymentRecord,
} from '../lib/operations-deployment';
import type { PlannedArtifact } from '../lib/operations-plan';
import {
  transitionSchema,
  type Transition,
} from '../lib/operations-transition';

interface PromotionFixture {
  directory: string;
  save: (file: string, value: unknown) => void;
  read: (file: string) => unknown;
  ops: (...args: string[]) => Promise<CommandResult>;
  state: () => InstallationState;
  deployment: (id: string) => DeploymentRecord;
  transition: (id: string) => Transition;
  calls: () => string[][];
  transitions: () => Transition[];
  promote: (
    kind: 'apply' | 'update' | 'rollback',
    target: PlannedArtifact,
  ) => Promise<CommandResult>;
  apply: () => Promise<CommandResult>;
  cleanup: () => void;
}

/** Exercise the public CLI with durable Docker responses and injected boundary failures. */
export function promotionFixture(
  state: InstallationState,
  desired: {
    https: InstallationState['applied']['https'];
    applications: PlannedArtifact[];
  },
): PromotionFixture {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ddh-promotion-')));
  const save = (file: string, value: unknown) => {
    writeFileSync(join(directory, file), JSON.stringify(value));
  };
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(join(directory, file), 'utf8'));
  state = { ...state, directory };
  save('state.json', state);
  save('deployment.json', {
    name: state.name,
    https: desired.https,
    images: Object.fromEntries(
      desired.applications.map(({ declaration, image }) => [
        declaration.name,
        image,
      ]),
    ),
  });
  save('artifacts.json', desired.applications);
  save('control.json', {});
  save('calls.json', []);
  save('database.json', 'running');
  save('compose.json', operationsCompose(state, false));
  save('gateway.json', operationsCompose(state, false).services);
  mkdirSync(join(directory, 'secrets'));
  for (const secret of [
    'tls.key',
    'tls.crt',
    'broker-password',
    ...state.retained.databases.flatMap(({ application }) =>
      ['admin', 'owner', 'runtime'].map(
        (role) => `${application}-${role}-password`,
      ),
    ),
  ])
    writeFileSync(join(directory, 'secrets', secret), 'fixture-secret\n');
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value));
const args = process.argv.slice(2);
save('calls.json', [...read('calls.json'), args]);
const control = read('control.json');
if (args[0] === 'create') {
  const image = args.find(arg => arg.includes('@sha256:'));
  const artifact = read('artifacts.json').find(entry => entry.image === image);
  save('isolated.json', args.includes('/app/node_modules/@starter/capabilities/preflight.ts') ? artifact.declaration : artifact.migrations);
} else if (args[0] === 'start') console.log(JSON.stringify(read('isolated.json')));
else if (args[0] === 'ps') {
  if (args.includes('label=com.docker.compose.oneoff=False')) {
    for (const { declaration } of read('state.json').applied.applications)
      console.log('app-' + declaration.name + '\\trunning');
  }
} else if (args[0] === 'network' || args[0] === 'volume') {
  const deployment = read('state.json').pendingDeployment;
  if (control.failure === 'before-gateway' && args.includes('--format') && deployment &&
      read('apply-' + deployment + '.json').steps.some(step => step.kind === 'reconcile' && step.status === 'running')) process.exit(1);
} else if (args[0] === 'inspect') {
  const service = read('compose.json').services[args.at(-1)];
  console.log(JSON.stringify({image: service.image, process: 'running'}));
} else if (args[0] === 'compose') {
  const command = args[args.indexOf('--file') + 2];
  if (command === control.composeSignal?.command && args.includes(control.composeSignal.service)) {
    process.kill(process.ppid, control.composeSignal.signal);
    await Bun.sleep(30_000);
  }
  if (command === 'up') {
    if (args.at(-1).startsWith('postgres-')) save('database.json', 'running');
    if (args.at(-1) === 'gateway') {
      if (control.failure === 'during-gateway') process.exit(1);
      save('gateway.json', read('compose.json').services);
    }
  } else if (command === 'ps') {
    if (!args.at(-1).startsWith('postgres-') || read('database.json') === 'running') console.log(args.at(-1));
  } else if (command === 'exec') {
    const sql = args.at(-1);
    if (sql.includes('SELECT name FROM public.pgmigrations')) {
      if (control.unreadableHistory || read('database.json') !== 'running') process.exit(1);
      console.log((control.history ?? []).join('\\n'));
    }
    if (sql.includes('pg_dump') && control.maintenanceSignal) {
      process.kill(process.ppid, control.maintenanceSignal);
      await Bun.sleep(30_000);
    }
    const app = args.find(arg => arg.startsWith('app-'));
    if (app) console.log(JSON.stringify({http: true, readiness: {service: app.slice(4), consumer: {status: 'not_applicable'}, publisher: {status: 'not_applicable'}}, backlog: null}));
  } else if (command === 'cp') writeFileSync(args.at(-1), 'fixture archive');
  else if (command === 'run') {
    if (read('database.json') !== 'running') {
      console.error('Database is not running');
      process.exit(1);
    }
    if (args.includes('migration:status')) console.log(control.unknownMigration ? 'missing file\\t' + control.unknownMigration : '');
    if (args.includes('migration:up') && control.migrationFailure) process.exit(1);
    if (args.includes('migration:up') && control.signal) {
      process.kill(process.ppid, control.signal);
      await Bun.sleep(30_000);
    }
  } else if (command !== 'stop' && command !== 'logs') throw new Error('Unexpected Compose command: ' + command);
} else throw new Error('Unexpected Docker command: ' + args[0]);
`,
    { mode: 0o700 },
  );
  const ops = (...args: string[]) =>
    runCommand(
      [
        'bun',
        '--no-env-file',
        'scripts/operations.ts',
        `--directory=${directory}`,
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
        timeout: 15_000,
      },
    );
  const apply = async () => {
    const plan = await ops('plan');
    if (plan.code !== 0) throw new Error(plan.stderr);
    writeFileSync(join(directory, 'plan.json'), plan.stdout);
    return ops('apply', `--plan=${join(directory, 'plan.json')}`);
  };
  return {
    directory,
    save,
    read,
    ops,
    state: () => stateSchema.parse(read('state.json')),
    deployment: (id: string) =>
      deploymentRecordSchema.parse(read(`apply-${id}.json`)),
    transition: (id: string) =>
      transitionSchema.parse(read(`transition-${id}.json`)),
    calls: () => z.array(z.array(z.string())).parse(read('calls.json')),
    apply,
    transitions: () =>
      readdirSync(directory)
        .filter((file) => file.startsWith('transition-'))
        .map((file) => transitionSchema.parse(read(file))),
    promote: async (kind, target) => {
      if (kind === 'apply') return apply();
      const application = target.declaration.name;
      const previous = state.applied.applications.find(
        (entry) => entry.declaration.name === application,
      );
      save('compatibility.json', {
        application,
        currentImage: previous?.image,
        targetImage: target.image,
        migrationHistory:
          (read('control.json') as { history?: string[] }).history ?? [],
        schemaReview: 'The older image remains compatible with this schema.',
        eventContractReview:
          'Retained messages remain compatible with this image.',
      });
      return ops(
        kind,
        application,
        `--image=${target.image}`,
        ...(kind === 'rollback'
          ? [`--compatibility=${join(directory, 'compatibility.json')}`]
          : []),
      );
    },
    cleanup: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
