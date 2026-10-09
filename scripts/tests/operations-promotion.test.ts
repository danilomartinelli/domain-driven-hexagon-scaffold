import { rejects } from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeJson } from '../lib/operations-config';
import {
  artifact,
  health,
  installationFixture,
} from './installation-runtime-fixture';

test('promotion records migration, independent candidate observations and verified completion', async () => {
  const fixture = installationFixture();
  try {
    await fixture
      .connect()
      .promote({ kind: 'update', id: fixture.id, candidate: fixture.target });
    expect(fixture.transition()).toMatchObject({
      status: 'verified',
      migration: { outcome: 'completed' },
      runtime: { image: fixture.target.image, process: 'running' },
      verification: { outcome: 'verified' },
    });
    expect(fixture.state().applied.applications[0]).toMatchObject({
      image: fixture.target.image,
      migration: { result: 'committed' },
      startup: { result: 'verified' },
    });
    expect(fixture.state().pendingTransitions).toBeUndefined();
    expect(fixture.runtime.migrations.get('user')).toBe(1);
    expect(fixture.runtime.backups).toHaveLength(1);
  } finally {
    fixture.cleanup();
  }
});

for (const effect of ['before', 'after'] as const) {
  test(`startup failure ${effect} its effect is decided from independent runtime evidence`, async () => {
    const f = installationFixture();
    try {
      f.runtime.failures.set('start', effect);
      const result = f
        .connect()
        .promote({ kind: 'update', id: f.id, candidate: f.target });
      if (effect === 'after') {
        await result;
        expect(f.transition().status).toBe('verified');
        expect(f.runtime.processes.get('user')).toMatchObject({
          image: f.target.image,
          process: 'running',
        });
      } else {
        await rejects(result, /Candidate stopped/);
        expect(f.transition()).toMatchObject({
          status: 'verification-failed',
          verification: { reason: 'process-failed' },
        });
        expect(f.state().applied.applications[0].image).toBe(f.target.image);
        expect(f.runtime.processes.get('user')?.image).toBe(f.previous?.image);
      }
    } finally {
      f.cleanup();
    }
  });
}

for (const kind of ['apply', 'update', 'rollback'] as const) {
  for (const legacyStatus of [
    'verification-pending',
    'provisioning',
    'verified',
  ] as const) {
    test(`${kind} continues a ${legacyStatus} transition from disk without repeating migrations or backups`, async () => {
      const f = installationFixture();
      try {
        f.runtime.failures.set('gateway', 'before');
        const request = { id: f.id, candidate: f.target };
        const promotion = f.connect();
        const result =
          kind === 'apply'
            ? promotion.promote({
                ...request,
                kind,
                deployment: randomUUID(),
                recordAttempt: () => {},
              })
            : kind === 'rollback'
              ? promotion.promote({
                  ...request,
                  kind,
                  compatibilityReview: {
                    application: 'user',
                    currentImage: f.previous?.image ?? '',
                    targetImage: f.target.image,
                    migrationHistory: ['001_baseline'],
                    schemaReview: 'Compatible schema',
                    eventContractReview: 'Compatible events',
                  },
                })
              : promotion.promote({ ...request, kind });
        await rejects(result, /gateway unavailable/);
        const pending = f.transition();
        expect(pending.migration.outcome).toBe(
          kind === 'rollback' ? 'compatibility-reviewed' : 'completed',
        );
        expect(f.runtime.processes.get('user')?.process).toBe('running');
        writeJson(join(f.directory, `transition-${f.id}.json`), {
          ...pending,
          status: legacyStatus,
        });
        const backups = [...f.runtime.backups];
        const migrations = new Map(f.runtime.migrations);
        f.runtime.failures.clear();
        expect(await f.connect().continue(f.target)).toBe(true);
        expect(f.transition()).toMatchObject({
          status: 'verified',
          migration: pending.migration,
          backup: pending.backup,
        });
        expect(f.transition().attempts).toHaveLength(2);
        expect(f.runtime.backups).toEqual(backups);
        expect(f.runtime.migrations).toEqual(migrations);
        expect(f.state().pendingTransitions).toBeUndefined();
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const failure of [
  'missing',
  'malformed',
  'foreign',
  'applicability',
  'messaging',
  'http-unavailable',
  'image-mismatch',
] as const) {
  test(`${failure} readiness remains pending and serving until explicit continuation`, async () => {
    const target = artifact('user', 'b', true, true);
    const f = installationFixture(target);
    try {
      const ready = health(target);
      const evidence =
        failure === 'missing'
          ? { ...ready, readiness: null }
          : failure === 'malformed'
            ? { ...ready, readiness: { service: 'user' } }
            : failure === 'foreign'
              ? {
                  ...ready,
                  readiness: { ...ready.readiness, service: 'wallet' },
                }
              : failure === 'applicability'
                ? {
                    ...ready,
                    readiness: {
                      ...ready.readiness,
                      publisher: { status: 'not_applicable' },
                    },
                  }
                : failure === 'messaging'
                  ? health(target, false)
                  : failure === 'http-unavailable'
                    ? null
                    : ready;
      f.runtime.evidence.set('user', evidence);
      if (failure === 'image-mismatch')
        f.runtime.onEffect = (effect) => {
          if (effect === 'start')
            f.runtime.processes.set('user', {
              image: artifact('user', 'd').image,
              process: 'running',
            });
        };
      await rejects(
        f.connect().promote({ kind: 'update', id: f.id, candidate: target }),
        /pending/,
      );
      expect(f.transition()).toMatchObject({
        status: 'verification-pending',
        verification: {
          outcome: 'pending',
          reason: ['http-unavailable', 'image-mismatch'].includes(failure)
            ? 'http-unknown'
            : 'messaging-degraded',
        },
      });
      expect(f.runtime.processes.get('user')?.process).toBe('running');
      expect(f.runtime.cleanupAttempts).toEqual([]);
      f.runtime.evidence.set('user', ready);
      f.runtime.onEffect = undefined;
      expect(await f.connect().continue(target)).toBe(true);
      expect(f.transition().status).toBe('verified');
      expect(f.runtime.migrations.get('user')).toBe(1);
      expect(f.runtime.backups).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
}

for (const failure of ['process', 'http'] as const) {
  for (const cleanup of [
    'success',
    'diagnostics',
    'stop',
    'both',
    'cancelled-diagnostics',
  ] as const) {
    test(`${failure} verification preserves candidate-only cleanup with ${cleanup}`, async () => {
      const f = installationFixture();
      try {
        if (failure === 'process')
          f.runtime.onEffect = (effect) => {
            if (effect === 'start')
              f.runtime.processes.set('user', {
                image: f.target.image,
                process: 'exited',
              });
          };
        else
          f.runtime.evidence.set('user', { ...health(f.target), http: false });
        if (['diagnostics', 'both', 'cancelled-diagnostics'].includes(cleanup))
          f.runtime.failures.set('diagnostics', 'after');
        if (['stop', 'both'].includes(cleanup))
          f.runtime.failures.set('stopFailed', 'before');
        if (cleanup === 'cancelled-diagnostics')
          f.runtime.onEffect = (effect) => {
            if (effect === 'start' && failure === 'process')
              f.runtime.processes.set('user', {
                image: f.target.image,
                process: 'exited',
              });
            if (effect === 'diagnostics')
              f.controller.abort(new Error('cancelled'));
          };
        await rejects(
          f
            .connect()
            .promote({ kind: 'update', id: f.id, candidate: f.target }),
          (error: unknown) => {
            expect(error).toBeInstanceOf(Error);
            const message = (error as Error).message;
            if (
              ['diagnostics', 'both', 'cancelled-diagnostics'].includes(cleanup)
            )
              expect(message).toContain('diagnostics failed');
            if (['stop', 'both'].includes(cleanup))
              expect(message).toContain('stopFailed failed');
            return true;
          },
        );
        expect(f.runtime.cleanupAttempts).toEqual([
          'diagnostics:user',
          'stop:user',
        ]);
        expect(f.runtime.processes.get('wallet')).toEqual({
          image: f.sibling.image,
          process: 'running',
        });
        expect(f.transition()).toMatchObject({
          status:
            cleanup === 'cancelled-diagnostics'
              ? 'interrupted'
              : 'verification-failed',
          migration: { outcome: 'completed' },
          verification: { outcome: 'failed', reason: `${failure}-failed` },
        });
        expect(f.state().pendingTransitions?.user).toBe(f.id);
        if (!['stop', 'both'].includes(cleanup))
          expect(f.runtime.processes.get('user')?.process).toBe('exited');
        f.runtime.failures.clear();
        f.runtime.onEffect = undefined;
        f.runtime.evidence.set('user', health(f.target));
        expect(
          await f.connect(new AbortController().signal).continue(f.target),
        ).toBe(true);
        expect(f.runtime.migrations.get('user')).toBe(1);
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const at of ['start', 'observe', 'sleep'] as const) {
  test(`interruption during ${at} keeps a running candidate and durable recovery progress`, async () => {
    const f = installationFixture(artifact('user', 'b', true, true));
    try {
      f.runtime.evidence.set('user', health(f.target, false));
      if (at === 'sleep')
        f.clock.onSleep = () => {
          f.controller.abort(new Error('interrupted'));
        };
      else
        f.runtime.onEffect = (effect) => {
          if (
            effect === at &&
            f.runtime.processes.get('user')?.image === f.target.image
          )
            f.controller.abort(new Error('interrupted'));
        };
      await rejects(
        f.connect().promote({ kind: 'update', id: f.id, candidate: f.target }),
        /interrupted/,
      );
      expect(f.transition()).toMatchObject({
        status: 'interrupted',
        migration: { outcome: 'completed' },
        verification: { outcome: 'pending', reason: 'interrupted' },
      });
      expect(f.state().applied.applications[0].startup?.result).toBe(
        'interrupted',
      );
      expect(f.state().pendingTransitions?.user).toBe(f.id);
      expect(f.runtime.processes.get('user')?.process).toBe('running');
      expect(f.runtime.cleanupAttempts).toEqual([]);
      f.runtime.onEffect = undefined;
      f.clock.onSleep = undefined;
      f.runtime.evidence.set('user', health(f.target));
      expect(
        await f.connect(new AbortController().signal).continue(f.target),
      ).toBe(true);
      expect(f.runtime.migrations.get('user')).toBe(1);
      expect(f.runtime.backups).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
}

for (const timing of ['expiration', 'recovery', 'late-ready'] as const) {
  test(`verification clock preserves ${timing} polling semantics and real durable timestamps`, async () => {
    const f = installationFixture(artifact('user', 'b', true, true));
    const startedAt = Date.now();
    try {
      f.runtime.evidence.set('user', health(f.target, false));
      f.runtime.onEffect = (effect) => {
        if (effect === 'start') f.clock.elapsed += 90_000;
        if (effect === 'gateway') f.clock.elapsed += 10_000;
      };
      if (timing === 'recovery')
        f.clock.onSleep = () => {
          if (f.clock.elapsed === 159_500)
            f.runtime.evidence.set('user', health(f.target));
        };
      if (timing === 'late-ready')
        f.runtime.onObserve = () => {
          if (f.runtime.processes.get('user')?.image === f.target.image) {
            f.clock.elapsed += 60_001;
            f.runtime.evidence.set('user', health(f.target));
          }
        };
      const result = f
        .connect()
        .promote({ kind: 'update', id: f.id, candidate: f.target });
      if (timing === 'expiration')
        await rejects(result, /messaging verification pending/);
      else await result;
      expect(f.clock.elapsed).toBe(
        timing === 'expiration'
          ? 160_000
          : timing === 'recovery'
            ? 159_500
            : 160_001,
      );
      expect(f.clock.sleeps).toEqual(
        Array<number>(
          timing === 'expiration' ? 120 : timing === 'recovery' ? 119 : 0,
        ).fill(500),
      );
      const transition = f.transition();
      expect(transition.status).toBe(
        timing === 'expiration' ? 'verification-pending' : 'verified',
      );
      for (const timestamp of [
        transition.migration.completedAt,
        transition.runtime?.observedAt,
        f.state().applied.applications[0].migration?.at,
        f.state().applied.applications[0].startup?.at,
      ]) {
        const at = Date.parse(timestamp ?? '');
        expect(at).toBeGreaterThanOrEqual(startedAt);
        expect(at).toBeLessThanOrEqual(Date.now());
      }
    } finally {
      f.cleanup();
    }
  });
}

for (const kind of ['apply', 'update'] as const) {
  for (const effect of ['before', 'after'] as const) {
    test(`${kind} migration failure ${effect} effects retains the stopped prior image and failure evidence`, async () => {
      const f = installationFixture();
      try {
        f.runtime.failures.set('migrate', effect);
        await rejects(
          f.connect().promote(
            kind === 'apply'
              ? {
                  kind,
                  id: f.id,
                  candidate: f.target,
                  deployment: randomUUID(),
                  recordAttempt: () => {},
                }
              : { kind, id: f.id, candidate: f.target },
          ),
          /migrate failed/,
        );
        expect(f.state().applied.applications[0]).toMatchObject({
          image: f.previous?.image,
          migration: { result: 'failed' },
        });
        expect(f.transition()).toMatchObject({
          status: 'failed',
          migration: { outcome: 'failed' },
        });
        expect(f.runtime.processes.get('user')).toEqual({
          image: f.previous?.image ?? '',
          process: 'exited',
        });
        expect(f.runtime.migrations.get('user') ?? 0).toBe(
          effect === 'after' ? 1 : 0,
        );
        expect(f.runtime.backups).toHaveLength(1);
        expect(f.state().pendingTransitions).toBeUndefined();
        expect(await f.connect().continue(f.target, f.id)).toBe(false);
      } finally {
        f.cleanup();
      }
    });
  }
}

for (const database of ['absent', 'stopped'] as const) {
  for (const older of [true, false]) {
    test(`apply starts an existing ${database} database before reviewing ${older ? 'unknown' : 'compatible'} migrations`, async () => {
      const f = installationFixture();
      try {
        if (database === 'absent') f.runtime.databases.delete('user');
        else f.runtime.databases.set('user', 'stopped');
        f.runtime.unknownMigrations = older ? ['002_newer'] : [];
        f.runtime.migrationEvidence = older
          ? 'missing file\t002_newer'
          : 'pending\t001_baseline';
        f.runtime.onEffect = (effect) => {
          if (effect === 'history')
            expect(f.runtime.databases.get('user')).toBe('running');
        };
        const result = f.connect().promote({
          kind: 'apply',
          id: f.id,
          candidate: f.target,
          deployment: randomUUID(),
          recordAttempt: () => {},
        });
        if (older) {
          await rejects(result, /compatibility-reviewed rollback/);
          expect(f.runtime.processes.get('user')).toMatchObject({
            image: f.previous?.image,
            process: 'running',
          });
          expect(f.runtime.migrations.size).toBe(0);
        } else {
          await result;
          expect(f.transition().status).toBe('verified');
        }
        expect(f.transition().migrationStatus).toBe(
          f.runtime.migrationEvidence,
        );
        expect(f.runtime.databases.get('user')).toBe('running');
      } finally {
        f.cleanup();
      }
    });
  }
}

test('apply provisions new capability resources and records their retained identities before runtime effects', async () => {
  const f = installationFixture(artifact('user', 'b', true, true), null);
  try {
    f.runtime.onEffect = (effect) => {
      if (effect === 'database')
        expect(
          f
            .state()
            .retained.databases.some((entry) => entry.application === 'user'),
        ).toBe(true);
    };
    let linked = '';
    const deployment = randomUUID();
    await f.connect().promote({
      kind: 'apply',
      id: f.id,
      candidate: f.target,
      deployment,
      recordAttempt: (id) => {
        linked = id;
      },
    });
    expect(linked).toBe(f.id);
    expect(f.transition()).toMatchObject({ deployment, status: 'verified' });
    expect(f.runtime.provisioned.has('user')).toBe(true);
    expect(f.runtime.broker).toBe(true);
    expect(f.runtime.backups).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test('an unavailable final HTTP observation replaces earlier positive HTTP evidence without stopping the candidate', async () => {
  const f = installationFixture(
    artifact('user', 'b', false, true),
    artifact('user', 'a', false, true),
  );
  try {
    let probes = 0;
    f.runtime.onObserve = () => {
      if (f.runtime.processes.get('user')?.image !== f.target.image) return;
      probes++;
      f.clock.elapsed += 30_000;
      f.runtime.evidence.set(
        'user',
        probes === 1 ? health(f.target, false) : null,
      );
    };
    await rejects(
      f.connect().promote({ kind: 'update', id: f.id, candidate: f.target }),
      /HTTP probe unavailable/,
    );
    expect(probes).toBe(2);
    expect(f.transition()).toMatchObject({
      status: 'verification-pending',
      migration: { outcome: 'not-applicable' },
      runtime: { http: 'unknown', process: 'running' },
    });
    expect(f.runtime.cleanupAttempts).toEqual([]);
    f.runtime.onObserve = undefined;
    f.runtime.evidence.set('user', health(f.target));
    expect(await f.connect().continue(f.target)).toBe(true);
    expect(f.runtime.migrations.size).toBe(0);
  } finally {
    f.cleanup();
  }
});
