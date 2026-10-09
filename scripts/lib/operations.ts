import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { applicationDeclarationSchema } from '@starter/capabilities/declaration';
import { runCommand, type CommandResult } from './command';
import { withCleanup } from './cleanup';
import { operationsDiagnostics } from './operations-diagnostics';
import { probeApplication } from './operations-verification';
import {
  deploymentRecordSchema,
  deploymentSteps,
  deploymentSummary,
  requiresGatewayReload,
  type DeploymentRecord,
} from './operations-deployment';
import { verifyEnvironmentOwnership } from './ownership';
import { operationsCompose } from './operations-compose';
import {
  provisionApplication,
  verifyBrokerAccess,
  refreshOperationsGateway,
} from './operations-services';
import {
  operationsPromotion,
  pendingCandidate,
  unknownMigrations,
  olderImageError,
  incompleteVerificationError,
  IncompletePromotion,
  type CompatibilityReview,
} from './operations-promotion';
import {
  appliedMigrations,
  assessRecovery,
  backupApplication,
  migrationHistory,
  restoreApplication,
  verifyArchive,
} from './operations-backup';
import {
  appliedImages,
  desiredDivergence,
  desiredSelection,
  imageDigest,
  newInstallation,
  readInstallation,
  readJson,
  sameHttps,
  sameImages,
  selectDesiredImage,
  writeJson,
  type AppliedApplication,
  type Artifact,
  type DeploymentConfig,
  type InstallationState,
} from './operations-config';
import {
  deploymentPlan,
  matchesReviewedPlan,
  requiredServices,
  type DeploymentPlan,
  type PlannedArtifact,
} from './operations-plan';

const actions = [
  'plan',
  'apply',
  'retained',
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
  'continue',
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
      /^--(directory|image|output|input|compatibility|assessment|message|limit|offset|plan)=(.+)$/.exec(
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
  if (['prepare', 'plan', 'apply', 'retained'].includes(action) && name)
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
  /**
   * Inspect every desired image in isolation and preview its transition from the
   * applied installation. Neither planning nor its rejection changes anything.
   */
  const inspectDesired = async (): Promise<{
    state: InstallationState;
    https?: DeploymentConfig['https'];
    artifacts: PlannedArtifact[];
    plan: DeploymentPlan;
  }> => {
    const { config } = desiredSelection(installation);
    const existing = installation.state;
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
    return {
      state,
      https: config.https,
      artifacts: desired,
      plan: deploymentPlan({
        state,
        existing: Boolean(existing),
        desired: {
          ...(config.https ? { https: config.https } : {}),
          applications: desired,
        },
        histories,
        secretFiles: existsSync(secrets) ? readdirSync(secrets) : [],
        gatewayReloadPending: state.pendingDeployment
          ? requiresGatewayReload(
              deploymentRecordSchema.parse(
                readJson(
                  join(directory, `apply-${state.pendingDeployment}.json`),
                ),
              ),
            )
          : false,
      }),
    };
  };
  /** Refuse a stale, unsupplied or blocked plan before any inventory or environment change. */
  const reviewApply = async () => {
    const file = options.get('plan');
    if (!file)
      throw new Error(
        'Supply --plan=<reviewed plan file> containing the output of plan',
      );
    const reviewed = readJson(file);
    const inspected = await inspectDesired();
    const { plan, state } = inspected;
    if (!matchesReviewedPlan(reviewed, plan))
      throw new Error(
        'The reviewed plan no longer matches the installation or desired selection; nothing was changed. Run plan again and review it.',
      );
    if (plan.resources.missingSecrets.length)
      throw new Error(
        `Supply secret files before applying: ${plan.resources.missingSecrets.join(', ')}`,
      );
    // Render the target topology to validate every secret it will mount.
    operationsCompose({
      ...state,
      applied: {
        ...(inspected.https ? { https: inspected.https } : {}),
        applications: inspected.artifacts.map(({ image, declaration }) => ({
          image,
          declaration,
        })),
      },
    });
    if (existsSync(join(directory, 'recovery.json')))
      throw new Error('Complete restore assessment before changing topology');
    const promoted = new Set(
      deploymentSteps(plan).flatMap(({ kind, application }) =>
        kind === 'promote' && application ? [application] : [],
      ),
    );
    for (const application of promoted)
      if (pendingCandidate(state, application))
        throw incompleteVerificationError(application);
    for (const { application, unknownToImage } of plan.migrations)
      if (promoted.has(application) && unknownToImage?.length)
        throw olderImageError(application, unknownToImage);
    return inspected;
  };
  let completed = false;
  await withCleanup(async () => {
    if (action === 'plan') {
      if (installation.adopted)
        console.error(
          'Planning against the version 1 inventory adopted in memory; the next other operator command records it.',
        );
      console.log(JSON.stringify((await inspectDesired()).plan, null, 2));
      completed = true;
      return;
    }
    const applying = action === 'apply' ? await reviewApply() : undefined;
    let state = installation.state ?? applying?.state;
    const newlyPrepared = !installation.state;
    if (!state) {
      if (action !== 'prepare') throw new Error('Prepare the deployment first');
      const { config } = desiredSelection(installation);
      const artifacts: Artifact[] = [];
      for (const [app, image] of Object.entries(config.images))
        artifacts.push(await artifact(app, image));
      state = newInstallation(config.name, directory, artifacts, config.https);
    }
    const pendingId = name ? pendingCandidate(state, name) : undefined;
    if (
      pendingId &&
      name &&
      ['update', 'start', 'migrate', 'restore'].includes(action)
    )
      throw incompleteVerificationError(name);
    if (
      !name &&
      action === 'start' &&
      Object.keys(state.pendingTransitions ?? {}).length
    )
      throw new Error(
        'Continue or roll back pending applications before starting the complete installation',
      );
    if (action === 'continue' && name && !pendingId)
      throw new Error('Select the application with a pending transition');
    if (action === 'continue' && !name && !state.pendingDeployment)
      throw new Error(
        'No incomplete topology deployment to continue; select an application with a pending transition',
      );
    if (action === 'update' && state.pendingDeployment)
      throw new Error(
        'Continue the incomplete topology deployment, or apply a newly reviewed plan, before updating images',
      );
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
      (name || action !== 'continue') &&
      ['prepare', 'start', 'migrate', 'replay', 'restore', 'continue'].includes(
        action,
      )
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
        operationsCompose(
          value,
          !['down', 'stop', 'probe', 'retained'].includes(action),
        ),
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
    const migrateUp = (
      selected: Artifact,
      operation: 'migrate' | 'update' | 'apply',
    ) =>
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
    const provision = (application: string) =>
      provisionApplication(compose, application);
    const verifyBroker = (messenger: Artifact) =>
      verifyBrokerAccess(oneShot, messenger);
    const probe = async (selected: Artifact): Promise<string> =>
      compose([
        'exec',
        '-T',
        `app-${selected.declaration.name}`,
        'bun',
        '-e',
        `
        let response;
        for (let attempt = 0; attempt < 90; attempt++) {
          response = await fetch('http://127.0.0.1:3000/health/ready/http', { signal: AbortSignal.timeout(5000) });
          if (response.ok) break;
          await response.body?.cancel();
          await Bun.sleep(500);
        }
        console.log(JSON.stringify({
          readiness: await (await fetch('http://127.0.0.1:3000/health/ready')).json(),
          backlog: await (await fetch('http://127.0.0.1:3000/health/backlog')).json(),
        }));
        process.exit(response.ok ? 0 : 1);
      `,
      ]);
    /** Ordinary startup verifies HTTP; candidate transitions have their own verification. */
    const startApplication = (selected: Artifact) => {
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
          console.log(await probe(selected));
        },
        (result, at) => ({
          startup: {
            operation: 'start',
            image: selected.image,
            readiness: 'http',
            result: result === 'succeeded' ? 'verified' : result,
            at,
          },
        }),
      );
    };
    const refreshGateway = () => refreshOperationsGateway(current, compose);
    const promotion = operationsPromotion({
      store: {
        current,
        save: () => {
          writeJson(statePath, current);
        },
        saveCompose,
      },
      compose,
      execute,
      oneShot,
      signal: controller.signal,
      diagnostics,
    });
    const deploymentPath = (id: string) => join(directory, `apply-${id}.json`);
    const ownedLabels = [
      '--filter',
      `label=com.docker.compose.project=${current.project}`,
      '--filter',
      `label=dev.starter.owner=${current.owner}`,
    ];
    /** This installation's service containers and states, excluding one-off commands. */
    const ownedServices = async (): Promise<Map<string, string>> =>
      new Map(
        (
          await execute([
            'docker',
            'ps',
            '-a',
            ...ownedLabels,
            '--filter',
            'label=com.docker.compose.oneoff=False',
            '--format',
            '{{.Label "com.docker.compose.service"}}\t{{.State}}',
          ])
        )
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [service, state] = line.split('\t');
            return [service, state];
          }),
      );
    /** Stop and remove this installation's containers for services it no longer runs; volumes remain. */
    const retire = async (services: readonly string[]) => {
      for (const service of services) {
        const ids = await execute([
          'docker',
          'ps',
          '-aq',
          ...ownedLabels,
          '--filter',
          `label=com.docker.compose.service=${service}`,
        ]);
        if (!ids) continue;
        const containers = ids.split(/\s+/);
        await execute(['docker', 'stop', '-t', '20', ...containers], 60_000);
        await execute(['docker', 'rm', ...containers]);
      }
      // Networks of retired services would otherwise outlive Compose's knowledge of them.
      const defined = Object.keys(
        z
          .object({ networks: z.record(z.string(), z.unknown()) })
          .parse(operationsCompose(current, false)).networks,
      );
      const orphaned = (
        await execute([
          'docker',
          'network',
          'ls',
          ...ownedLabels,
          '--format',
          '{{.ID}}\t{{.Label "com.docker.compose.network"}}',
        ])
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'))
        .filter(([, network]) => !defined.includes(network))
        .map(([id]) => id);
      if (orphaned.length)
        await execute(['docker', 'network', 'rm', ...orphaned]);
    };
    /** Retire an application from the applied selection; its retained identities and data remain. */
    const removeApplication = async (application: string) => {
      const entry = current.applied.applications.find(
        (candidate) => candidate.declaration.name === application,
      );
      if (!entry) return;
      current.applied.applications = current.applied.applications.filter(
        (candidate) => candidate !== entry,
      );
      await retire([
        `app-${application}`,
        ...(entry.declaration.persistence ? [`postgres-${application}`] : []),
      ]);
      promotion.withdraw(application);
      writeJson(statePath, current);
      saveCompose();
    };
    /**
     * Stop infrastructure the applied selection no longer derives, then reload
     * changed ingress. Returns applied applications whose servers are not running.
     */
    const reconcile = async (
      https: DeploymentConfig['https'] | undefined,
      gatewayStale: boolean,
    ): Promise<string[]> => {
      if (!https && current.applied.https) {
        delete current.applied.https;
        writeJson(statePath, current);
        saveCompose();
      }
      const required = requiredServices(current.applied.applications);
      await retire(
        [...(await ownedServices()).keys()]
          .filter((service) => !required.has(service))
          .sort(),
      );
      if (gatewayStale) await refreshGateway();
      const states = await ownedServices();
      return current.applied.applications
        .map(({ declaration }) => declaration.name)
        .filter(
          (application) => states.get(`app-${application}`) !== 'running',
        );
    };
    /** Run a deployment's remaining steps in order; a failed step stops every later one. */
    const deploy = async (
      deployment: DeploymentRecord,
      operation: 'apply' | 'continue',
      artifacts: ReadonlyMap<string, Artifact>,
    ) => {
      const path = deploymentPath(deployment.id);
      const attempt: DeploymentRecord['attempts'][number] = {
        operation,
        at: now(),
        diagnostic: diagnostics.logPath,
        outcome: 'running',
        error: '',
      };
      deployment.attempts.push(attempt);
      deployment.status = 'applying';
      deployment.gatewayReloadPending = requiresGatewayReload(deployment);
      writeJson(path, deployment);
      const https = deployment.desired.https ?? undefined;
      let stopped: string[] = [];
      try {
        for (const step of deployment.steps) {
          if (step.status === 'completed') continue;
          // Persist the obligation before changing the applied selection; even
          // an interruption between that change and step completion must reload.
          if (
            step.kind === 'ingress' ||
            (step.kind === 'remove' &&
              current.applied.applications.some(
                (entry) =>
                  entry.declaration.name === step.application &&
                  entry.declaration.exposure,
              ))
          )
            deployment.gatewayReloadPending = true;
          step.status = 'running';
          writeJson(path, deployment);
          try {
            if (step.kind === 'ingress') {
              current.applied.https = https;
              writeJson(statePath, current);
              saveCompose();
            } else if (step.kind === 'remove' && step.application) {
              await removeApplication(step.application);
            } else if (step.kind === 'promote') {
              const target = step.application
                ? artifacts.get(step.application)
                : undefined;
              if (!target) throw new Error('Promotion has no desired image');
              const lastId = step.transitions.at(-1);
              if (!lastId || !(await promotion.continue(target, lastId))) {
                const id = randomUUID();
                await promotion.promote({
                  kind: 'apply',
                  id,
                  candidate: target,
                  deployment: deployment.id,
                  recordAttempt: (transitionId) => {
                    step.transitions.push(transitionId);
                    writeJson(path, deployment);
                  },
                });
              }
              // Candidate verification reloads the gateway from the applied selection.
              deployment.gatewayReloadPending = false;
            } else {
              stopped = await reconcile(https, deployment.gatewayReloadPending);
              deployment.gatewayReloadPending = false;
            }
          } catch (error) {
            step.status =
              error instanceof IncompletePromotion ? error.status : failure();
            throw error;
          }
          step.status = 'completed';
          step.completedAt = now();
          writeJson(path, deployment);
        }
        deployment.status = 'completed';
        attempt.outcome = 'completed';
        delete current.pendingDeployment;
        writeJson(statePath, current);
        console.log(
          `Topology deployment ${deployment.id} applied:\n${deploymentSummary(deployment)}`,
        );
        // A superseded failure can leave a prior server stopped; never restart it implicitly.
        if (stopped.length)
          console.log(
            `Applied applications not running: ${stopped.join(', ')}. Inspect status and start them explicitly.`,
          );
      } catch (error) {
        deployment.status = 'incomplete';
        attempt.outcome = controller.signal.aborted
          ? 'interrupted'
          : 'incomplete';
        attempt.error =
          error instanceof Error ? error.message : 'Deployment step failed';
        throw new Error(
          `${attempt.error}\nTopology deployment incomplete; completed steps, resources and data are retained:\n${deploymentSummary(deployment)}\nInspect ${path}, repair the cause and run continue, or plan and apply a new selection.`,
          { cause: error },
        );
      } finally {
        writeJson(path, deployment);
      }
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
          await provision(entry.declaration.name);
        const messenger = current.applied.applications.find(
          (entry) => entry.declaration.messaging,
        );
        if (messenger) await verifyBroker(messenger);
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
      for (const entry of selected) await startApplication(entry);
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
      // Ownership was verified above; orphans are this installation's retired services.
      await compose([
        '--profile',
        'applications',
        '--profile',
        'commands',
        'down',
        '--timeout',
        '20',
        '--remove-orphans',
      ]);
      console.log(
        'Owned containers and networks stopped; volumes, secrets and inventory retained',
      );
    } else if (action === 'probe') {
      console.log(
        JSON.stringify(await probeApplication(requiredApp(), compose, execute)),
      );
    } else if (action === 'apply') {
      if (!applying) throw new Error('Apply requires a reviewed plan');
      const id = randomUUID();
      const superseded = current.pendingDeployment;
      if (superseded) {
        const path = deploymentPath(superseded);
        writeJson(path, {
          ...deploymentRecordSchema.parse(readJson(path)),
          status: 'superseded',
          supersededBy: id,
        });
      }
      const deployment: DeploymentRecord = {
        id,
        status: 'applying',
        createdAt: now(),
        desired: {
          https: applying.https ?? null,
          images: appliedImages(applying.artifacts),
        },
        baseline: {
          https: current.applied.https ?? null,
          images: appliedImages(current.applied.applications),
        },
        steps: deploymentSteps(applying.plan),
        gatewayReloadPending:
          applying.plan.services.recreate.includes('gateway'),
        attempts: [],
        supersededBy: null,
      };
      writeJson(deploymentPath(id), deployment);
      current.pendingDeployment = id;
      writeJson(statePath, current);
      await deploy(
        deployment,
        'apply',
        new Map(
          applying.artifacts.map(({ image, declaration }) => [
            declaration.name,
            { image, declaration },
          ]),
        ),
      );
    } else if (action === 'continue' && !name) {
      assessRecovery(directory, options.get('assessment'));
      const path = deploymentPath(current.pendingDeployment ?? '');
      const deployment = deploymentRecordSchema.parse(readJson(path));
      const { config } = desiredSelection(installation);
      if (
        !sameImages(config.images, deployment.desired.images) ||
        !sameHttps(config.https, deployment.desired.https ?? undefined)
      )
        throw new Error(
          'deployment.json no longer selects the deployment being continued; restore it, or plan and apply the edited selection',
        );
      const artifacts = new Map<string, Artifact>();
      for (const [application, image] of Object.entries(config.images))
        artifacts.set(application, await artifact(application, image));
      await deploy(deployment, 'continue', artifacts);
      rmSync(join(directory, 'recovery.json'), { force: true });
    } else if (action === 'retained') {
      const containers = await ownedServices();
      const volumes = (
        await execute(['docker', 'volume', 'ls', '-q', ...ownedLabels])
      ).split('\n');
      const active = requiredServices(current.applied.applications);
      const describe = (service: string, volume: string) => ({
        activity: active.has(service) ? 'active' : 'inactive',
        container: containers.get(service) ?? 'absent',
        volumePresent: volumes.includes(volume),
      });
      console.log(
        JSON.stringify(
          {
            databases: current.retained.databases.map((entry) => ({
              ...entry,
              ...describe(entry.service, entry.volume),
            })),
            broker: current.retained.broker
              ? {
                  ...current.retained.broker,
                  ...describe(
                    current.retained.broker.service,
                    current.retained.broker.volume,
                  ),
                }
              : null,
          },
          null,
          2,
        ),
      );
    } else if (action === 'continue') {
      assessRecovery(directory, options.get('assessment'));
      const selected = requiredApp();
      if (!(await promotion.continue(selected)))
        throw new Error(
          'Continuation requires the selected candidate and a confirmed migration outcome',
        );
      rmSync(join(directory, 'recovery.json'), { force: true });
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
      let compatibilityReview: CompatibilityReview | undefined;
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
      if (action === 'update' && candidate.declaration.persistence) {
        const history = await appliedHistory(
          current.project,
          candidate.declaration.name,
        );
        const packaged = await packagedMigrations(
          candidate.declaration.name,
          candidate.image,
        );
        if (history) {
          const unknown = unknownMigrations(history, packaged);
          if (unknown.length)
            throw olderImageError(candidate.declaration.name, unknown);
        }
      }
      // The request becomes desired before the environment changes; the applied
      // outcomes below, not this selection, record whether it succeeded.
      selectDesiredImage(
        installation,
        previous.declaration.name,
        candidate.image,
      );
      const request = { id: randomUUID(), candidate };
      if (action === 'rollback') {
        if (!compatibilityReview)
          throw new Error('Rollback requires a compatibility review');
        await promotion.promote({
          ...request,
          kind: 'rollback',
          compatibilityReview,
        });
      } else await promotion.promote({ ...request, kind: 'update' });
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
