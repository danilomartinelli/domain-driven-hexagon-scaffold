import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../database/environment';
import { digestSchema, platformSchema } from './publication';
import { approveArtifact, monotonicClock } from './artifact-approval';
import { dockerImageRuntime } from './platform-image-runtime';
import { disposableKong } from './kong-admin';

/** Internal child of the disposable test runner, never an installation command. */
export async function approvePlatformImage(
  name: string,
  image: string,
  platform: string,
  signal: AbortSignal,
): Promise<boolean> {
  digestSchema.parse(image);
  platformSchema.parse(platform);
  assertTestEnvironment();
  const manifest = readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE ?? '');
  const [app] = manifest.topology ?? [];
  if (
    manifest.environment !== 'test' ||
    manifest.topology?.length !== 1 ||
    app.name !== name
  )
    throw new Error(
      'Artifact approval requires a disposable test environment selecting exactly the application',
    );
  const verdict = await approveArtifact({
    app,
    image,
    platform,
    environment: manifest,
    runtime: dockerImageRuntime({ app, image, platform, manifest, signal }),
    ...(manifest.gateway ? { kong: disposableKong(manifest, signal) } : {}),
    clock: monotonicClock,
    signal,
  });
  if (verdict.status === 'approved') {
    const transition = verdict.evidence.gateway;
    if (transition)
      console.log(
        `Kong ${transition.upstream} target ${transition.target} address ${transition.address} ${transition.transition.join(' -> ')}`,
      );
    console.log(
      `Artifact approval ${name}: approved within 60000 ms (elapsed=${String(Math.round(verdict.evidence.elapsedMs))} ms)`,
    );
  } else
    for (const condition of verdict.unmet)
      console.error(`Artifact approval ${name}: ${condition}`);
  console.log(JSON.stringify(verdict));
  return verdict.status === 'approved';
}
