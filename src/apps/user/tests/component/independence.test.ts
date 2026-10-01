import { expect, test } from 'bun:test';
import {
  assertTestEnvironment,
  readEnvironmentFile,
} from '../../../../../database/environment';
import { withCleanup } from '../../../../../scripts/tests/cleanup';
import {
  getHttpServer,
  ownerDatabase,
  startUser,
  stopUser,
} from './user-process';

async function docker(args: string[]): Promise<string> {
  const child = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, 25_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Docker ${args[0]} failed: ${stderr}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

test('User starts, creates over REST and GraphQL and restarts with only its own database running', async () => {
  assertTestEnvironment();
  const file = process.env.DDH_ENVIRONMENT_FILE;
  if (!file) throw new Error('Missing owned manifest');
  const manifest = readEnvironmentFile(file);
  const ids = (
    await docker([
      'ps',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${manifest.project}`,
      '--filter',
      `label=dev.starter.owner=${manifest.owner}`,
    ])
  )
    .split('\n')
    .filter(Boolean);
  const siblings: string[] = [];
  const siblingServices: string[] = [];
  for (const id of ids) {
    const service = await docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "com.docker.compose.service"}}',
      id,
    ]);
    if (service !== 'postgres-user') {
      siblings.push(id);
      siblingServices.push(service);
    }
  }
  expect(siblingServices.sort()).toEqual(
    [
      ...manifest.databases
        .filter((database) => database.app !== 'user')
        .map((database) => `postgres-${database.app}`),
      'rabbitmq',
      'gateway',
    ].sort(),
  );
  await withCleanup(async () => {
    await stopUser();
    await docker(['stop', '--time', '3', ...siblings]);
    for (const id of siblings)
      expect(
        await docker(['inspect', '--format', '{{.State.Running}}', id]),
      ).toBe('false');
    await startUser();
    const profile = {
      email: 'offline@example.com',
      country: 'England',
      street: 'Baker street',
      postalCode: 'NW16XE',
    };
    await getHttpServer().post('/v1/users').send(profile).expect(201);
    const graphql = await getHttpServer()
      .post('/graphql')
      .send({
        query:
          'mutation Create($input: CreateUserGqlRequestDto!) { create(input: $input) { id } }',
        variables: {
          input: { ...profile, email: 'graphql-offline@example.com' },
        },
      })
      .expect(200);
    expect(graphql.body).toHaveProperty('data.create.id');
    expect(graphql.body).not.toHaveProperty('errors');
    const pending = (
      await ownerDatabase().query('SELECT * FROM user_outbox ORDER BY event_id')
    ).rows;
    expect(pending).toHaveLength(2);
    await stopUser();
    await startUser();
    expect(
      (
        await ownerDatabase().query(
          'SELECT * FROM user_outbox ORDER BY event_id',
        )
      ).rows,
    ).toEqual(pending);
    const listed = await getHttpServer().get('/v1/users').expect(200);
    expect(listed.body).toMatchObject({ count: 2 });
  }, [
    async () => {
      await stopUser();
      await startUser();
    },
    async () => {
      await docker(['start', ...siblings]);
      const deadline = Date.now() + 20_000;
      for (;;) {
        const states = await docker([
          'inspect',
          '--format',
          '{{.State.Health.Status}}',
          ...siblings,
        ]);
        if (states.split('\n').every((state) => state === 'healthy')) break;
        if (Date.now() > deadline)
          throw new Error('Sibling infrastructure did not recover');
        await Bun.sleep(100);
      }
    },
  ]);
}, 60_000);
