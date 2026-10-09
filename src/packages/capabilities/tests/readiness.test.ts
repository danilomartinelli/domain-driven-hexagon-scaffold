import { expect, test } from 'bun:test';
import {
  parseReadinessSnapshot,
  parseHttpReadiness,
} from '@starter/capabilities/readiness';

const declaration = {
  name: 'reports',
  persistence: false,
  messaging: true,
  exposure: false,
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
  service: 'reports',
  lifecycle: 'running',
  http: { status: 'ready' },
  database: { status: 'not_applicable' },
  consumer: readyRole,
  publisher: { status: 'not_applicable' },
} as const;

test('readiness rejects a declared messaging capability with no applicable role', () => {
  expect(
    parseReadinessSnapshot(
      { ...snapshot, consumer: { status: 'not_applicable' } },
      declaration,
    ),
  ).toMatchObject({ valid: false });
});

test('private HTTP readiness validates service identity and status', () => {
  expect(
    parseHttpReadiness({ service: 'reports', status: 'ready' }, declaration),
  ).toEqual({ valid: true, snapshot: { service: 'reports', status: 'ready' } });
});

for (const persistence of [false, true])
  for (const messaging of [false, true])
    for (const exposure of [false, true]) {
      test(`readiness respects persistence=${String(persistence)}, messaging=${String(messaging)}, exposure=${String(exposure)}`, () => {
        const app = { ...declaration, persistence, messaging, exposure };
        const report = {
          ...snapshot,
          database: { status: persistence ? 'ready' : 'not_applicable' },
          consumer: messaging ? readyRole : { status: 'not_applicable' },
        };
        expect(parseReadinessSnapshot(report, app)).toMatchObject({
          valid: true,
          snapshot: report,
        });
        expect(
          parseReadinessSnapshot(
            {
              ...report,
              database: { status: persistence ? 'not_applicable' : 'ready' },
            },
            app,
          ).valid,
        ).toBe(false);
        expect(
          parseReadinessSnapshot(
            {
              ...report,
              consumer: messaging ? { status: 'not_applicable' } : readyRole,
            },
            app,
          ).valid,
        ).toBe(false);
      });
    }

for (const [field, value] of Object.entries({
  status: 'unknown',
  connected: false,
  reason: 'unavailable',
  failures: -1,
  retries: 0.5,
  retryDelayMs: -1,
  lastFailureAt: 42,
})) {
  test(`readiness rejects an inconsistent or malformed messaging ${field}`, () => {
    expect(
      parseReadinessSnapshot(
        { ...snapshot, consumer: { ...readyRole, [field]: value } },
        declaration,
      ).valid,
    ).toBe(false);
  });
}
for (const value of [
  null,
  {},
  { ...snapshot, service: 'other' },
  { ...snapshot, lifecycle: 'unknown' },
  { ...snapshot, http: { status: 'not_applicable' } },
  { ...snapshot, consumer: { status: 'ready' } },
]) {
  test(`readiness rejects malformed snapshot ${JSON.stringify(value)}`, () => {
    expect(parseReadinessSnapshot(value, declaration).valid).toBe(false);
  });
}
test('valid degraded and draining snapshots remain available for caller policy', () => {
  for (const lifecycle of ['running', 'draining', 'stopping']) {
    expect(
      parseReadinessSnapshot(
        {
          ...snapshot,
          lifecycle,
          http: { status: 'not_ready' },
          consumer: {
            ...readyRole,
            status: 'not_ready',
            connected: false,
            reason: 'messaging_unavailable',
          },
        },
        declaration,
      ).valid,
    ).toBe(true);
  }
});
for (const value of [
  null,
  {},
  { service: 'other', status: 'ready' },
  { service: 'reports', status: 'unknown' },
  { service: 'reports', status: 'not_applicable' },
]) {
  test(`private HTTP rejects malformed response ${JSON.stringify(value)}`, () => {
    expect(parseHttpReadiness(value, declaration).valid).toBe(false);
  });
}
