import { expect, test } from 'bun:test';
import { probeApplication } from '../lib/operations-docker-runtime';
import type { Artifact } from '../lib/operations-config';

const candidate: Artifact = {
  image: `example/user@sha256:${'b'.repeat(64)}`,
  declaration: {
    name: 'user',
    persistence: false,
    messaging: true,
    exposure: false,
  },
};
const readyRole = {
  status: 'ready',
  connected: true,
  failures: 0,
  retries: 0,
  retryDelayMs: 0,
  lastFailureAt: null,
  reason: null,
};
const snapshot = {
  service: 'user',
  lifecycle: 'running',
  http: { status: 'ready' },
  database: { status: 'not_applicable' },
  consumer: { status: 'not_applicable' },
  publisher: readyRole,
};

for (const [name, readiness, messaging] of [
  ['ready publisher', snapshot, 'ready'],
  ['missing snapshot', null, 'unknown'],
  ['malformed snapshot', { service: 'user' }, 'unknown'],
  ['foreign service', { ...snapshot, service: 'wallet' }, 'unknown'],
  [
    'inconsistent applicability',
    { ...snapshot, publisher: { status: 'not_applicable' } },
    'unknown',
  ],
  [
    'disconnected ready role',
    { ...snapshot, publisher: { ...readyRole, connected: false } },
    'unknown',
  ],
  [
    'degraded publisher',
    {
      ...snapshot,
      publisher: {
        ...readyRole,
        status: 'not_ready',
        connected: false,
        reason: 'messaging_unavailable',
      },
    },
    'not_ready',
  ],
] as const) {
  test(`Docker observation classifies ${name} using the application readiness contract`, async () => {
    const observed = await probeApplication(
      candidate,
      (args) =>
        Promise.resolve(
          args[0] === 'ps'
            ? 'candidate-container'
            : JSON.stringify({ http: true, readiness, backlog: null }),
        ),
      () =>
        Promise.resolve(
          JSON.stringify({ image: candidate.image, process: 'running' }),
        ),
    );
    expect(observed).toMatchObject({ http: 'ready', messaging });
  });
}

for (const response of ['unavailable', 'malformed', 'negative'] as const) {
  test(`Docker observation preserves ${response} HTTP evidence`, async () => {
    const observed = await probeApplication(
      candidate,
      (args) => {
        if (args[0] === 'ps') return Promise.resolve('candidate-container');
        if (response === 'unavailable')
          return Promise.reject(new Error('transport unavailable'));
        return Promise.resolve(
          response === 'malformed'
            ? '{'
            : JSON.stringify({
                http: false,
                readiness: snapshot,
                backlog: null,
              }),
        );
      },
      () =>
        Promise.resolve(
          JSON.stringify({ image: candidate.image, process: 'running' }),
        ),
    );
    expect(observed.http).toBe(
      response === 'negative' ? 'not_ready' : 'unknown',
    );
  });
}
