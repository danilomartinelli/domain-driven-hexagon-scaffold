import { expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { environmentPrefix } from '@starter/capabilities/declaration';
import {
  assertTestEnvironment,
  environmentVariables,
  readEnvironmentFile,
} from '../../../database/environment';
import { imageRuntime } from '../image-runtime';
import { withCleanup } from '../cleanup';

assertTestEnvironment();
const manifest = readEnvironmentFile(process.env.DDH_ENVIRONMENT_FILE ?? '');
const [app] = manifest.topology ?? [];
if (manifest.topology?.length !== 1)
  throw new Error('Select one application artifact');
const publication = process.env.DDH_PUBLICATION_READINESS === 'true';
const prefix = environmentPrefix(app.name);
const migration: Record<string, string> = {};
const runtime: Record<string, string> = { NODE_ENV: 'production' };
for (const [key, value] of Object.entries(environmentVariables(manifest, {}))) {
  if (
    value !== undefined &&
    (key.startsWith(`${prefix}_`) || key.startsWith('RABBITMQ_'))
  ) {
    migration[key] = value;
    if (!key.includes('_MIGRATION_')) runtime[key] = value;
  }
}
const image = await imageRuntime(
  app.name,
  manifest,
  runtime,
  migration,
  tmpdir(),
);
await withCleanup(async () => {
  const migrationResult = await image.migrate('up');
  if (app.persistence) {
    expect(migrationResult.code, migrationResult.stderr).toBe(0);
    expect((await image.migrate('status')).code).toBe(0);
    expect(
      (
        await image.migrate('up', {
          DATABASE_APP: app.name === 'user' ? 'wallet' : 'user',
        })
      ).code,
    ).not.toBe(0);
    expect(
      (
        await image.migrate('up', {
          [`${prefix}_DB_MIGRATION_USERNAME`]: `${app.name.replaceAll('-', '_')}_runtime`,
        })
      ).code,
    ).not.toBe(0);
  } else {
    expect(migrationResult.code).not.toBe(0);
    expect(migrationResult.stderr).toContain('Script not found');
  }
  await image.start({}, publication ? 'publication' : undefined);
  if (!publication) {
    expect((await image.probe('/health/live')).status).toBe(200);
    expect((await image.probe('/health/ready/http')).status).toBe(200);
    expect((await image.probe('/health/ready/database')).body).toMatchObject({
      status: app.persistence ? 'ready' : 'not_applicable',
    });
    if (!app.messaging)
      expect((await image.probe('/health/ready/consumer')).body).toMatchObject({
        status: 'not_applicable',
      });
    if (!app.exposure) expect((await image.probe('/graphql')).status).toBe(404);
  }
  await image.stop();
}, [() => withCleanup(image.stop, [image.cleanup])]);
