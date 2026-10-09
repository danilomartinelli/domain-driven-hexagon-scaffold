import type { ApplicationDeclaration } from '@starter/capabilities/declaration';
import {
  parseHttpReadiness,
  parseReadinessSnapshot,
} from '@starter/capabilities/readiness';
import { isOwnedCleanupFailure } from './owned-container';
import { withCleanup } from './cleanup';
import { imagePlatform, imageMigrations } from './image-contract';
import { gatewayConfiguration } from './gateway';
import { observeGateway } from './artifact-approval/gateway';
import type {
  ApprovalClock,
  ApprovalEnvironment,
  GatewayEvidence,
  KongAdmin,
  PlatformImageRuntime,
} from './artifact-approval/ports';
export type {
  ApprovalClock,
  ApprovalEnvironment,
  GatewayEvidence,
  KongAdmin,
  KongEntity,
  KongTarget,
  PlatformImageRuntime,
} from './artifact-approval/ports';

const READINESS_WINDOW_MS = 60_000;
export const monotonicClock: ApprovalClock = {
  now: () => performance.now(),
  sleep: (milliseconds) => Bun.sleep(milliseconds),
};
export type ApprovalVerdict =
  | {
      status: 'approved';
      evidence: {
        image: string;
        platform: string;
        elapsedMs: number;
        gateway?: GatewayEvidence;
      };
    }
  | { status: 'rejected'; unmet: string[] };

/** Decide the image contract and technical readiness; adapters own only effects. */
export async function approveArtifact(input: {
  app: ApplicationDeclaration;
  image: string;
  platform: string;
  environment: ApprovalEnvironment;
  runtime: PlatformImageRuntime;
  kong?: KongAdmin;
  clock: ApprovalClock;
  signal?: AbortSignal;
}): Promise<ApprovalVerdict> {
  const { app, image, platform, environment, runtime, kong, clock, signal } =
    input;
  return withCleanup(async () => {
    const unmet = new Set<string>();
    const record = (error: unknown, conditions = unmet) => {
      if (isOwnedCleanupFailure(error)) throw error;
      signal?.throwIfAborted();
      conditions.add(error instanceof Error ? error.message : String(error));
    };
    signal?.throwIfAborted();
    try {
      await imagePlatform(runtime, platform);
    } catch (error) {
      record(error);
    }
    for (const condition of await imageMigrations(app, runtime, signal))
      unmet.add(condition);
    let failed = unmet.size > 0;
    const started = clock.now();
    const deadline = started + READINESS_WINDOW_MS;
    const remainingWindow = () => {
      signal?.throwIfAborted();
      const remaining = Math.floor(deadline - clock.now());
      if (remaining <= 0)
        throw new Error('Technical readiness window exhausted (60000 ms)');
      return remaining;
    };
    const budget = () => Math.min(2000, remainingWindow());
    let running = false;
    let ready = false;
    let elapsedMs = 0;
    let gateway: GatewayEvidence | undefined;
    try {
      await runtime.start(Math.max(1, deadline - clock.now()));
      running = true;
    } catch (error) {
      record(error);
      failed = true;
    }
    if (running) {
      for (const check of [
        async () => {
          if (await runtime.publishedPorts(remainingWindow()))
            throw new Error('Runtime container publishes host ports');
        },
        async () => {
          if (await runtime.hostReachable(remainingWindow()))
            throw new Error('Application port is reachable from the host');
        },
      ]) {
        try {
          await check();
        } catch (error) {
          record(error);
          failed = true;
        }
      }
      let installed = false;
      const observe = kong
        ? observeGateway(environment, app, kong, budget)
        : undefined;
      const readinessErrors = new Set<string>();
      while (clock.now() < deadline) {
        signal?.throwIfAborted();
        try {
          if (app.exposure && !kong)
            throw new Error('Exposed application has no disposable gateway');
          if (kong && !installed) {
            await kong.install(
              gatewayConfiguration(environment, true, undefined, 'approval'),
              budget(),
            );
            installed = true;
          }
          const connected = observe ? await observe() : true;
          const http = await runtime.probe('/health/ready/http', budget());
          const privateHttp = parseHttpReadiness(http.body, app);
          if (!privateHttp.valid) throw new Error(privateHttp.reason);
          if (http.status !== 200 || privateHttp.snapshot.status !== 'ready')
            throw new Error('Private HTTP is not ready');
          const response = await runtime.probe('/health/ready', budget());
          const parsed = parseReadinessSnapshot(response.body, app);
          if (!parsed.valid) throw new Error(parsed.reason);
          const state = parsed.snapshot;
          if (
            response.status !== 200 ||
            state.lifecycle !== 'running' ||
            state.http.status !== 'ready' ||
            state.database.status !==
              (app.persistence ? 'ready' : 'not_applicable') ||
            [state.consumer, state.publisher].some(
              (role) => role.status === 'not_ready',
            )
          )
            throw new Error(
              `Technical readiness: lifecycle=${state.lifecycle}; http=${state.http.status}; database=${state.database.status}; consumer=${state.consumer.status}; publisher=${state.publisher.status}`,
            );
          budget();
          if (!connected)
            throw new Error(
              'Kong active target recovery has not been observed',
            );
          gateway = typeof connected === 'object' ? connected : undefined;
          elapsedMs = clock.now() - started;
          ready = true;
          break;
        } catch (error) {
          record(error, readinessErrors);
        }
        await clock.sleep(Math.max(0, Math.min(100, deadline - clock.now())));
      }
      if (!ready) {
        for (const condition of readinessErrors) unmet.add(condition);
        unmet.add(
          `Technical readiness exhausted 60000 ms (elapsed=${String(Math.round(clock.now() - started))} ms)`,
        );
      }
      try {
        const stopped = await runtime.stop();
        if (stopped.code !== 0) {
          unmet.add(
            `Runtime stop exited with ${String(stopped.code)} instead of 0`,
          );
          failed = true;
        }
      } catch (error) {
        record(error);
        failed = true;
      }
    }
    signal?.throwIfAborted();
    return !failed && ready
      ? {
          status: 'approved',
          evidence: {
            image,
            platform,
            elapsedMs,
            ...(gateway ? { gateway } : {}),
          },
        }
      : { status: 'rejected', unmet: [...unmet] };
  }, [() => runtime.cleanup()]);
}
