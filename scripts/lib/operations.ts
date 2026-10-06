import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { applicationDeclarationSchema } from '@starter/capabilities/declaration';
import { runCommand, type CommandResult } from './command';
import { withCleanup } from './cleanup';
import { operationsDiagnostics } from './operations-diagnostics';
import { verifyEnvironmentOwnership } from './ownership';
import { operationsCompose, provisionDatabase } from './operations-compose';
import {
  appliedMigrations,
  assessRecovery,
  backupApplication,
  migrationHistory,
  restoreApplication,
  verifyArchive,
} from './operations-backup';
import {
  desiredDivergence,
  desiredSelection,
  imageDigest,
  newInstallation,
  readInstallation,
  readJson,
  selectDesiredImage,
  writeJson,
  type AppliedApplication,
  type Artifact,
} from './operations-config';
import { deploymentPlan, type PlannedArtifact } from './operations-plan';

const actions = [
  'plan',
  'prepare',
  'migrate',
  'status',
  'start',
  'stop',
  'down',
  'probe',
  'inspect',
  'replay',
  'update',
  'rollback',
  'backup',
  'restore',
];

/** Operator commands own one inventory and never accept ambient Compose or application settings. */
export async function runOperations(args: string[]): Promise<void> {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const match =
      /^--(directory|image|output|input|compatibility|assessment|message|limit|offset)=(.+)$/.exec(
        arg,
      );
    if (!match || options.has(match[1]))
      throw new Error('Invalid or duplicate operation option');
    options.set(match[1], match[2]);
  }
  const [action, name, ...extra] = positional;
  const requestedDirectory = options.get('directory');
  if (
    !requestedDirectory ||
    extra.length ||
    !action ||
    !actions.includes(action)
  )
    throw new Error(
      `Usage: bun run ops --directory=<directory> ${actions.join('|')} [application]`,
    );
  if ((action === 'prepare' || action === 'plan') && name)
    throw new Error(
      `${action} applies to the complete installation; omit the application argument`,
    );
  // Recorded inventory, not the desired selection, identifies what commands operate.
  const installation = readInstallation(requestedDirectory);
  const directory = installation.directory;
  const diagnostics = operationsDiagnostics(directory, action);
  const lock = join(directory, '.operation-lock');
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(
      'Another operation holds .operation-lock; do not run concurrent operators',
    );
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    COMPOSE_DISABLE_ENV_FILE: '1',
    COMPOSE_PROFILES: '',
  };
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort(130);
    process.exitCode = 130;
  };
  const terminate = () => {
    controller.abort(143);
    process.exitCode = 143;
  };
  const hangup = () => {
    controller.abort(129);
    process.exitCode = 129;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', hangup);
  const execute = async (
    command: string[],
    timeout = 90_000,
    cleanup = false,
  ): Promise<string> => {
    if (!cleanup && controller.signal.aborted)
      throw new Error('Operation interrupted; owned data retained');
    const result = await runCommand(command, {
      cwd: directory,
      env,
      timeout,
      maxOutput: 2_000_000,
      ...(cleanup ? {} : { signal: controller.signal }),
    });
    diagnostics.record(result, cleanup);
    if (result.code !== 0)
      throw new Error(
        `Operator command${cleanup ? ' cleanup' : ''} failed (${String(result.code)}); resources and database are retained. Diagnostic: ${diagnostics.logPath}`,
      );
    return result.stdout.trim();
  };
  const composePath = join(directory, 'compose.json');
  const composeProject =
    (project: string) =>
    (command: string[], timeout?: number, cleanup = false) =>
      execute(
        [
          'docker',
          'compose',
          '--project-name',
          project,
          '--file',
          composePath,
          ...command,
        ],
        timeout,
        cleanup,
      );
  const removeTransient = async (
    container: string,
    owner: string,
  ): Promise<void> => {
    const ids = await execute(
      [
        'docker',
        'ps',
        '-aq',
        '--filter',
        `name=^/${container}$`,
        '--filter',
        `label=dev.starter.owner=${owner}`,
      ],
      15_000,
      true,
    );
    if (ids)
      await execute(['docker', 'rm', '-f', ...ids.split(/\s+/)], 30_000, true);
  };
  /** Run packaged image code without network, secrets, environment or a writable filesystem. */
  const isolated = async (
    app: string,
    image: string,
    purpose: string,
    command: string[],
  ): Promise<CommandResult> => {
    if (controller.signal.aborted)
      throw new Error(`Operation interrupted before image ${purpose}`);
    const owner = randomUUID();
    const container = `ddh-preflight-${owner}`;
    return withCleanup(async () => {
      // Docker may finish creating a container after its client is killed. Wait
      // for this bounded creation request before honoring cancellation, so the
      // named resource exists before cleanup inspects it.
      const created = await runCommand(
        [
          'docker',
          'create',
          '--rm',
          `--name=${container}`,
          `--label=dev.starter.owner=${owner}`,
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--entrypoint=bun',
          image,
          '--no-env-file',
          ...command,
        ],
        {
          cwd: directory,
          env,
          timeout: 90_000,
          maxOutput: 2_000_000,
        },
      );
      diagnostics.record(created, false);
      if (created.code !== 0)
        throw new Error(
          `Image ${purpose} creation failed for ${app}; diagnostic: ${diagnostics.logPath}`,
        );
      if (controller.signal.aborted)
        throw new Error(
          `Operation interrupted before image ${purpose} startup`,
        );
      const result = await runCommand(
        ['docker', 'start', '--attach', container],
        {
          cwd: directory,
          env,
          timeout: 90_000,
          maxOutput: 2_000_000,
          signal: controller.signal,
        },
      );
      diagnostics.record(result, false);
      return result;
    }, [() => removeTransient(container, owner)]);
  };
  const artifact = async (app: string, image: string): Promise<Artifact> => {
    imageDigest.parse(image);
    const result = await isolated(app, image, 'preflight', [
      '/app/node_modules/@starter/capabilities/preflight.ts',
      '/app/app',
    ]);
    if (result.code !== 0) {
      // Forward only the contract's identifier-only diagnostic; image output
      // must never echo operator secrets or arbitrary application data.
      const reason =
        /Application [a-z][a-z0-9-]*: (?:group [a-z][a-z0-9-]* requires (?:persistence|messaging|exposure)|(?:persistence|messaging|exposure) integration is not prepared)/.exec(
          result.stderr,
        )?.[0];
      throw new Error(
        `Image preflight failed for ${app}: ${reason ?? 'invalid or unavailable compatibility contract'}; prepare a compatible composition. Diagnostic: ${diagnostics.logPath}`,
      );
    }
    const declaration = applicationDeclarationSchema.parse(
      JSON.parse(result.stdout),
    );
    if (declaration.name !== app)
      throw new Error(
        `Image does not own the selected application; it declares ${declaration.name}`,
      );
    return { image, declaration };
  };
  /** Packaged migration names, read from the artifact without database access. */
  const packagedMigrations = async (
    app: string,
    image: string,
  ): Promise<string[]> => {
    const result = await isolated(app, image, 'migration inventory', [
      '-e',
      "const { readdirSync } = await import('node:fs'); const { database } = await Bun.file('/app/distribution.json').json(); console.log(JSON.stringify(database ? readdirSync(`/app/${database.migrations}`).filter((file) => file.endsWith('.sql')).sort().map((file) => file.slice(0, -4)) : []));",
    ]);
    if (result.code !== 0)
      throw new Error(
        `Image migration inventory failed for ${app}; diagnostic: ${diagnostics.logPath}`,
      );
    return z.array(z.string()).parse(JSON.parse(result.stdout));
  };
  /** Planning reads only running databases; it never starts a service to answer. */
  const appliedHistory = async (
    project: string,
    app: string,
  ): Promise<string[] | undefined> => {
    if (!existsSync(composePath)) return undefined;
    const compose = composeProject(project);
    try {
      if (
        !(await compose([
          'ps',
          '--status',
          'running',
          '--quiet',
          `postgres-${app}`,
        ]))
      )
        return undefined;
      return await appliedMigrations(app, compose);
    } catch (error) {
      // The diagnostic log retains the failure; the plan reports it as unavailable.
      if (controller.signal.aborted) throw error;
      return undefined;
    }
  };
  const plan = async (): Promise<void> => {
    const { config } = desiredSelection(installation);
    const existing = installation.state;
    if (installation.adopted)
      console.error(
        'Planning against the version 1 inventory adopted in memory; the next other operator command records it.',
      );
    const state = existing ?? newInstallation(config.name, directory, []);
    await verifyEnvironmentOwnership(state, execute, Boolean(existing));
    const desired: PlannedArtifact[] = [];
    const rejected: string[] = [];
    for (const [app, image] of Object.entries(config.images)) {
      try {
        const inspected = await artifact(app, image);
        desired.push({
          ...inspected,
          migrations: inspected.declaration.persistence
            ? await packagedMigrations(app, image)
            : [],
        });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        rejected.push(
          `${app}: ${error instanceof Error ? error.message : 'image inspection failed'}`,
        );
      }
    }
    if (
      !config.https &&
      desired.some(({ declaration }) => declaration.exposure)
    )
      rejected.push(
        'https: exposed applications require an HTTPS bind/port and certificate files',
      );
    if (rejected.length)
      throw new Error(
        `Desired selection rejected; nothing was changed:\n- ${rejected.join('\n- ')}`,
      );
    const histories: Record<string, string[] | undefined> = {};
    for (const { application } of state.retained.databases)
      if (
        desired.some(
          ({ declaration }) =>
            declaration.name === application && declaration.persistence,
        )
      )
        histories[application] = await appliedHistory(
          state.project,
          application,
        );
    const secrets = join(directory, 'secrets');
    console.log(
      JSON.stringify(
        deploymentPlan({
          state,
          existing: Boolean(existing),
          desired: {
            ...(config.https ? { https: config.https } : {}),
            applications: desired,
          },
          histories,
          secretFiles: existsSync(secrets) ? readdirSync(secrets) : [],
        }),
        null,
        2,
      ),
    );
  };
  let completed = false;
  await withCleanup(async () => {
    if (action === 'plan') {
      await plan();
      completed = true;
      return;
    }
    let state = installation.state;
    const newlyPrepared = !state;
    if (!state) {
      if (action !== 'prepare') throw new Error('Prepare the deployment first');
      const { config } = desiredSelection(installation);
      const artifacts: Artifact[] = [];
      for (const [app, image] of Object.entries(config.images))
        artifacts.push(await artifact(app, image));
      state = newInstallation(config.name, directory, artifacts, config.https);
    }
    // Validate selected immutable artifacts before rewriting Compose/state,
    // supplying credentials to containers, stopping services or running migrations.
    let validatedCandidate: Artifact | undefined;
    if (action === 'update' || action === 'rollback') {
      const image = options.get('image');
      if (
        !name ||
        !state.applied.applications.some(
          (entry) => entry.declaration.name === name,
        )
      )
        throw new Error('Select a prepared application');
      if (!image) throw new Error('Supply --image=<repository@sha256:digest>');
      desiredSelection(installation, name);
      validatedCandidate = await artifact(name, image);
    } else if (
      !newlyPrepared &&
      ['prepare', 'start', 'migrate', 'replay', 'restore'].includes(action)
    ) {
      for (const entry of state.applied.applications)
        if (!name || name === entry.declaration.name)
          await artifact(entry.declaration.name, entry.image);
    }
    const current = state;
    await verifyEnvironmentOwnership(current, execute, !newlyPrepared);
    const statePath = join(directory, 'state.json');
    const saveCompose = (value = current) => {
      writeJson(
        composePath,
        operationsCompose(value, !['down', 'stop', 'probe'].includes(action)),
      );
    };
    saveCompose();
    writeJson(statePath, current);
    if (installation.adopted)
      console.error(
        'Recorded the existing inventory as applied and retained state; identities, credentials, volumes and deployment.json are unchanged.',
      );
    const compose = composeProject(current.project);
    const now = () => new Date().toISOString();
    const failure = () =>
      controller.signal.aborted
        ? ('interrupted' as const)
        : ('failed' as const);
    const recordOutcome = (
      application: string,
      outcome: Partial<Pick<AppliedApplication, 'migration' | 'startup'>>,
    ) => {
      const entry = current.applied.applications.find(
        (candidate) => candidate.declaration.name === application,
      );
      if (entry) Object.assign(entry, outcome);
      writeJson(statePath, current);
    };
    const oneShot = async (
      service: string,
      command: string[],
    ): Promise<string> => {
      const container = `${current.project}-command-${randomUUID()}`;
      return withCleanup(
        () =>
          compose([
            'run',
            '--rm',
            '--no-deps',
            '--name',
            container,
            service,
            ...command,
          ]),
        [() => removeTransient(container, current.owner)],
      );
    };
    const app = name
      ? current.applied.applications.find(
          (entry) => entry.declaration.name === name,
        )
      : undefined;
    if (name && !app) throw new Error('Application is not selected');
    const requiredApp = (): Artifact => {
      if (!app) throw new Error('Select one application');
      return app;
    };
    const persistent = (): Artifact => {
      const selected = requiredApp();
      if (!selected.declaration.persistence)
        throw new Error(
          'Application has no persistence or migration interface',
        );
      return selected;
    };
    const migrate = async (
      selected: Artifact,
      command: 'up' | 'status',
    ): Promise<string> => {
      if (!selected.declaration.persistence)
        throw new Error(
          'Application has no persistence or migration interface',
        );
      return oneShot(`migrate-${selected.declaration.name}`, [
        'run',
        `migration:${command}`,
      ]);
    };
    /** Record a step's outcome on its application whether it succeeds, fails or is interrupted. */
    const recordedStep = async <T>(
      application: string,
      step: () => Promise<T>,
      outcome: (
        result: 'succeeded' | 'failed' | 'interrupted',
        at: string,
      ) => Partial<Pick<AppliedApplication, 'migration' | 'startup'>>,
    ): Promise<T> => {
      let value: T;
      try {
        value = await step();
      } catch (error) {
        recordOutcome(application, outcome(failure(), now()));
        throw error;
      }
      recordOutcome(application, outcome('succeeded', now()));
      return value;
    };
    /** Commit migrations, recording their outcome separately from startup. */
    const migrateUp = (selected: Artifact, operation: 'migrate' | 'update') =>
      recordedStep(
        selected.declaration.name,
        () => migrate(selected, 'up'),
        (result, at) => ({
          migration: {
            operation,
            image: selected.image,
            result: result === 'succeeded' ? 'committed' : result,
            at,
          },
        }),
      );
    const probe = async (
      selected: Artifact,
      wait = false,
      readiness: 'http' | 'all' = 'all',
    ): Promise<string> =>
      compose([
        'exec',
        '-T',
        `app-${selected.declaration.name}`,
        'bun',
        '-e',
        `
        let response;
        for (let attempt = 0; attempt < ${wait ? '90' : '1'}; attempt++) {
          response = await fetch('http://127.0.0.1:3000/health/ready${readiness === 'http' ? '/http' : ''}', { signal: AbortSignal.timeout(5000) });
          if (response.ok || ${wait ? 'false' : 'true'}) break;
          await response.body?.cancel();
          await Bun.sleep(500);
        }
        console.log(JSON.stringify({
          readiness: await (await fetch('http://127.0.0.1:3000/health/ready')).json(),
          backlog: await (await fetch('http://127.0.0.1:3000/health/backlog')).json(),
        }));
        process.exit(${wait ? 'response.ok ? 0 : 1' : '0'});
      `,
      ]);
    /** Start one selected server; `start` verifies HTTP and image changes full readiness. */
    const startApplication = (
      selected: Artifact,
      operation: 'start' | 'update' | 'rollback',
    ) => {
      const readiness = operation === 'start' ? 'http' : 'full';
      return recordedStep(
        selected.declaration.name,
        async () => {
          await compose([
            'up',
            '-d',
            '--no-deps',
            '--wait',
            '--wait-timeout',
            '60',
            `app-${selected.declaration.name}`,
          ]);
          console.log(
            await probe(selected, true, readiness === 'full' ? 'all' : 'http'),
          );
        },
        (result, at) => ({
          startup: {
            operation,
            image: selected.image,
            readiness,
            result: result === 'succeeded' ? 'verified' : result,
            at,
          },
        }),
      );
    };
    const refreshGateway = async () => {
      if (
        current.applied.applications.some((entry) => entry.declaration.exposure)
      )
        await compose([
          'up',
          '-d',
          '--no-deps',
          '--force-recreate',
          '--wait',
          '--wait-timeout',
          '60',
          'gateway',
        ]);
    };
    if (action === 'prepare') {
      const infra = current.applied.applications
        .filter((entry) => entry.declaration.persistence)
        .map((entry) => `postgres-${entry.declaration.name}`);
      if (
        current.applied.applications.some(
          (entry) => entry.declaration.messaging,
        )
      )
        infra.push('rabbitmq');
      try {
        if (infra.length)
          await compose([
            'up',
            '-d',
            '--wait',
            '--wait-timeout',
            '60',
            ...infra,
          ]);
        for (const entry of current.applied.applications.filter(
          (entry) => entry.declaration.persistence,
        ))
          await compose([
            'exec',
            '-T',
            `postgres-${entry.declaration.name}`,
            'sh',
            '-ec',
            provisionDatabase(entry.declaration.name),
          ]);
        const messenger = current.applied.applications.find(
          (entry) => entry.declaration.messaging,
        );
        if (messenger)
          await oneShot(`app-${messenger.declaration.name}`, [
            '-e',
            "import {connect} from 'amqplib'; import {configurationValue} from '@starter/nest-support/configuration'; try { const c=await connect({hostname:process.env.RABBITMQ_HOST,port:5672,username:process.env.RABBITMQ_USERNAME,password:configurationValue('RABBITMQ_PASSWORD'),vhost:process.env.RABBITMQ_VHOST},{timeout:2000});await c.close(); } catch { process.exit(1); }",
          ]);
      } catch (error) {
        await withCleanup(() => {
          throw error;
        }, [
          async () => {
            if (newlyPrepared) {
              await verifyEnvironmentOwnership(
                current,
                (args) => execute(args, 15_000, true),
                true,
              );
              await compose(
                [
                  '--profile',
                  'applications',
                  '--profile',
                  'commands',
                  'down',
                  '--timeout',
                  '20',
                ],
                90_000,
                true,
              );
            }
          },
        ]);
      }
      console.log(
        `Prepared ${current.project}; identities and data retained. Run owned migrations explicitly.`,
      );
      const divergence = desiredDivergence(installation);
      if (divergence)
        console.log(
          `${divergence} Preparation does not apply topology changes.`,
        );
    } else if (action === 'status') {
      console.log(await migrate(persistent(), 'status'));
    } else if (action === 'migrate') {
      console.log(await migrateUp(persistent(), 'migrate'));
    } else if (action === 'start') {
      assessRecovery(directory, options.get('assessment'));
      const selected = app ? [app] : current.applied.applications;
      for (const entry of selected.filter(
        (entry) => entry.declaration.persistence,
      )) {
        const status = await migrate(entry, 'status');
        if (/^pending\t/m.test(status))
          throw new Error('Run pending owned migrations before startup');
      }
      for (const entry of selected) await startApplication(entry, 'start');
      await refreshGateway();
      rmSync(join(directory, 'recovery.json'), { force: true });
    } else if (action === 'stop') {
      await compose([
        'stop',
        '--timeout',
        '20',
        ...(app ? [app] : current.applied.applications).map(
          (entry) => `app-${entry.declaration.name}`,
        ),
      ]);
    } else if (action === 'down') {
      await compose([
        '--profile',
        'applications',
        '--profile',
        'commands',
        'down',
        '--timeout',
        '20',
      ]);
      console.log(
        'Owned containers and networks stopped; volumes, secrets and inventory retained',
      );
    } else if (action === 'probe') {
      console.log(await probe(requiredApp()));
    } else if (action === 'inspect' || action === 'replay') {
      const selected = requiredApp();
      if (!selected.declaration.messaging)
        throw new Error('Application has no messaging capability');
      const recoverable = await execute([
        'docker',
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--entrypoint=bun',
        selected.image,
        '--no-env-file',
        '-e',
        "console.log(await Bun.file('/app/app/messaging/failures.ts').exists())",
      ]);
      if (recoverable !== 'true')
        throw new Error(
          'Application has no owned failure-queue interface; supply messaging/failures.ts with application-specific replay validation before recovery',
        );
      const forward = ['message', 'limit', 'offset'].flatMap((key) =>
        options.has(key) ? [`--${key}=${options.get(key) ?? ''}`] : [],
      );
      console.log(
        await oneShot(`app-${selected.declaration.name}`, [
          'app/messaging/failures.ts',
          action,
          ...forward,
        ]),
      );
    } else if (action === 'backup') {
      const output = options.get('output');
      if (!output) throw new Error('Supply --output=<new archive path>');
      console.log(
        await backupApplication(current, persistent(), output, compose),
      );
    } else if (action === 'restore') {
      const input = options.get('input');
      if (!input) throw new Error('Supply --input=<verified archive path>');
      const selected = persistent();
      // A refused archive leaves the database and its recorded outcome unchanged.
      const archive = await verifyArchive(current, selected, input, compose);
      await recordedStep(
        selected.declaration.name,
        () => restoreApplication(current, selected, archive, compose),
        (result, at) => ({
          migration: {
            operation: 'restore',
            image: archive.metadata.image,
            result: result === 'succeeded' ? 'restored' : result,
            at,
          },
        }),
      );
      console.log(
        'Database restored. RabbitMQ is unchanged; review recovery.json and supply a data/messaging assessment before start.',
      );
    } else if (action === 'update' || action === 'rollback') {
      if (existsSync(join(directory, 'recovery.json')))
        throw new Error('Complete restore assessment before changing images');
      const previous = requiredApp();
      const candidate = validatedCandidate;
      if (!candidate) throw new Error('Candidate preflight is required');
      if (
        JSON.stringify(candidate.declaration) !==
        JSON.stringify(previous.declaration)
      )
        throw new Error(
          'Capability/route changes require a separately planned resource transition; review them with plan. Image updates preserve the applied topology',
        );
      let compatibilityReview: unknown = null;
      if (action === 'rollback') {
        const file = options.get('compatibility');
        if (!file)
          throw new Error(
            'Rollback requires --compatibility=<schema and event-contract review>',
          );
        const review = z
          .strictObject({
            application: z.literal(previous.declaration.name),
            currentImage: z.literal(previous.image),
            targetImage: z.literal(candidate.image),
            migrationHistory: z.array(z.string()),
            schemaReview: z.string().min(20),
            eventContractReview: z.string().min(20),
          })
          .parse(readJson(file));
        compatibilityReview = review;
        const history = previous.declaration.persistence
          ? await migrationHistory(previous.declaration.name, compose)
          : [];
        if (JSON.stringify(review.migrationHistory) !== JSON.stringify(history))
          throw new Error(
            'Database migration history changed since the compatibility review',
          );
      }
      // The request becomes desired before the environment changes; the applied
      // outcomes below, not this selection, record whether it succeeded.
      selectDesiredImage(
        installation,
        previous.declaration.name,
        candidate.image,
      );
      const id = randomUUID();
      const transitionPath = join(directory, `transition-${id}.json`);
      const transition = {
        action,
        application: previous.declaration.name,
        previousImage: previous.image,
        candidateImage: candidate.image,
        compatibilityReview,
        status: 'preparing',
        migrationStatus: '',
        backup: '',
        error: '',
        diagnostic: diagnostics.logPath,
      };
      writeJson(transitionPath, transition);
      const promoted = () =>
        current.applied.applications.map((entry) =>
          entry.declaration.name === previous.declaration.name
            ? { ...entry, ...candidate }
            : entry,
        );
      await withCleanup(async () => {
        try {
          saveCompose({
            ...current,
            applied: { ...current.applied, applications: promoted() },
          });
          if (candidate.declaration.persistence)
            transition.migrationStatus = await migrate(candidate, 'status');
          // A short per-application maintenance window prevents writes during schema transition.
          await compose([
            'stop',
            '--timeout',
            '20',
            `app-${previous.declaration.name}`,
          ]);
          if (candidate.declaration.persistence) {
            transition.backup = await backupApplication(
              current,
              previous,
              join(
                directory,
                'backups',
                `${previous.declaration.name}-${id}.dump`,
              ),
              compose,
            );
            transition.status =
              action === 'update' ? 'migrating' : 'compatibility-reviewed';
            writeJson(transitionPath, transition);
            if (action === 'update') await migrateUp(candidate, 'update');
          }
          transition.status = 'promoting';
          writeJson(transitionPath, transition);
          // Only successful migrations can select the candidate for application startup.
          current.applied.applications = promoted();
          writeJson(statePath, current);
          await startApplication(candidate, action);
          await refreshGateway();
          transition.status = 'verified';
          console.log(
            `${action} verified: ${candidate.declaration.name} ${candidate.image}`,
          );
        } catch (error) {
          transition.status = 'failed';
          transition.error =
            'No automatic database reversal. Inspect status and retained transition evidence before recovery.';
          throw error;
        }
      }, [
        () => {
          writeJson(transitionPath, transition);
        },
        () => {
          saveCompose();
        },
      ]);
    } else {
      throw new Error('Operation is not implemented');
    }
    completed = true;
  }, [
    () => {
      diagnostics.finish(Number(process.exitCode) || (completed ? 0 : 1));
    },
    () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.off('SIGHUP', hangup);
      rmSync(lock, { recursive: true });
    },
  ]);
}
