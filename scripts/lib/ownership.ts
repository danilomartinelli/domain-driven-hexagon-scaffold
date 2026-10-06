import type { EnvironmentManifest } from '../../database/environment';

/** Inspect the whole retained inventory before adopting, changing or stopping a run. */
export async function verifyEnvironmentOwnership(
  manifest: EnvironmentManifest,
  inspect: (args: string[]) => Promise<string>,
  allowExisting: boolean,
): Promise<void> {
  for (const resource of ['container', 'network', 'volume'] as const) {
    const ids = await inspect(
      resource === 'container'
        ? [
            'docker',
            'ps',
            '-aq',
            '--filter',
            `label=com.docker.compose.project=${manifest.project}`,
          ]
        : [
            'docker',
            resource,
            'ls',
            '-q',
            '--filter',
            `label=com.docker.compose.project=${manifest.project}`,
          ],
    );
    if (!ids) continue;
    if (!allowExisting)
      throw new Error('Refusing to adopt existing resources for a new run.');
    const owners = await inspect([
      'docker',
      resource,
      'inspect',
      '--format',
      resource === 'container'
        ? '{{index .Config.Labels "dev.starter.owner"}}'
        : '{{index .Labels "dev.starter.owner"}}',
      ...ids.split(/\s+/),
    ]);
    if (owners.split(/\s+/).some((owner) => owner !== manifest.owner))
      throw new Error('Refusing resource owned by another environment.');
  }
}
