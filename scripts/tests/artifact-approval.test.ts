import { rejects } from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { approveArtifact } from '../lib/artifact-approval';
import { runKongApproval } from './kong-approval-fixture';
import { runSlowPortApproval } from './image-approval-fixture';
import {
  approvalFixture,
  MemoryKong,
  readyRole,
} from './artifact-approval-fixture';

test('artifact approval owns the verdict and cleans the approved platform image runtime', async () => {
  const fixture = approvalFixture();
  expect(await approveArtifact(fixture)).toMatchObject({
    status: 'approved',
    evidence: { platform: 'linux/arm64', elapsedMs: 0 },
  });
  expect(fixture.state.cleaned).toBe(true);
  expect(fixture.state.running).toBe(false);
});

test('artifact approval accepts a slow Docker port inspection within the readiness window', async () => {
  const result = await runSlowPortApproval();
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    verdict: { status: 'approved' },
    cleaned: true,
  });
}, 15_000);

test('one-shot inspections share the remaining window while readiness probes keep their per-attempt cap', async () => {
  const fixture = approvalFixture();
  fixture.state.startDelay = 5000;
  const timeouts: number[] = [];
  const inspect = (timeout: number) => {
    timeouts.push(timeout);
    fixture.clock.elapsed += Math.min(3000, timeout);
    if (timeout < 3000) throw new Error('Inspection timed out');
  };
  fixture.runtime.publishedPorts = (timeout) => {
    inspect(timeout);
    return Promise.resolve('');
  };
  fixture.runtime.hostReachable = (timeout) => {
    inspect(timeout);
    return Promise.resolve(false);
  };
  const probe = fixture.runtime.probe;
  const probes: number[] = [];
  fixture.runtime.probe = (path, timeout) => {
    probes.push(timeout);
    return probe(path, timeout);
  };
  expect(await approveArtifact(fixture)).toMatchObject({
    status: 'approved',
    evidence: { elapsedMs: 11_000 },
  });
  expect(timeouts).toEqual([55_000, 52_000]);
  expect(probes).toEqual([2000, 2000]);
  expect(fixture.state.cleaned).toBe(true);
});

test('one-shot inspections cannot extend an exhausted readiness window', async () => {
  const fixture = approvalFixture();
  fixture.state.startDelay = 59_000;
  let hostChecks = 0;
  let probes = 0;
  fixture.runtime.publishedPorts = (timeout) => {
    fixture.clock.elapsed += timeout;
    return Promise.reject(new Error('Port inspection timed out'));
  };
  fixture.runtime.hostReachable = () => {
    hostChecks++;
    return Promise.resolve(false);
  };
  fixture.runtime.probe = () => {
    probes++;
    return Promise.resolve(fixture.state.http);
  };
  expect(await approveArtifact(fixture)).toMatchObject({ status: 'rejected' });
  expect(fixture.clock.now()).toBe(60_000);
  expect(hostChecks).toBe(0);
  expect(probes).toBe(0);
  expect(fixture.state.cleaned).toBe(true);
  expect(fixture.state.running).toBe(false);
});

for (const [name, change, condition] of [
  [
    'wrong architecture',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.platform.arch = 'x64';
    },
    'requested architecture',
  ],
  [
    'unexpected migration interface',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.absentMigration = false;
    },
    'no migration interface',
  ],
  [
    'owner migration failure',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.migrationCode = 1;
    },
    'Owner migration up',
  ],
  [
    'cross-application migration',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.crossMigrationCode = 0;
    },
    'Cross-application',
  ],
  [
    'runtime migration privileges',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.runtimeMigrationCode = 0;
    },
    'runtime credentials',
  ],
  [
    'published port',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.publishedPorts = '3000/tcp -> 0.0.0.0:3000';
    },
    'publishes host ports',
  ],
  [
    'host listener',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.hostReachable = true;
    },
    'reachable from the host',
  ],
  [
    'stop failure',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.stopCode = 137;
    },
    'stop exited with 137',
  ],
  [
    'forced stop at grace',
    (f: ReturnType<typeof approvalFixture>) => {
      f.state.stopDelay = 20_000;
      f.state.stopCode = 137;
    },
    'stop exited with 137',
  ],
] as const) {
  test(`artifact approval rejects ${name}`, async () => {
    const fixture = approvalFixture({
      persistence:
        name.includes('migration') && name !== 'unexpected migration interface',
    });
    change(fixture);
    const verdict = await approveArtifact(fixture);
    expect(verdict.status).toBe('rejected');
    if (verdict.status === 'rejected')
      expect(verdict.unmet.join('\n')).toContain(condition);
    expect(fixture.state.cleaned).toBe(true);
  });
}

test('artifact approval reports distinct unmet conditions in observation order', async () => {
  const fixture = approvalFixture();
  fixture.state.platform.arch = 'x64';
  fixture.state.absentMigration = false;
  fixture.state.publishedPorts = '3000/tcp';
  fixture.state.hostReachable = true;
  fixture.state.stopCode = 137;
  expect(await approveArtifact(fixture)).toEqual({
    status: 'rejected',
    unmet: [
      'Image must execute as Linux on the requested architecture',
      'A nonpersistent image must have no migration interface',
      'Runtime container publishes host ports',
      'Application port is reachable from the host',
      'Runtime stop exited with 137 instead of 0',
    ],
  });
});

test('artifact approval records the same Kong target and address recovering through active checks', async () => {
  const fixture = approvalFixture({ exposure: true });
  expect(
    await approveArtifact({ ...fixture, kong: new MemoryKong() }),
  ).toMatchObject({
    status: 'approved',
    evidence: {
      elapsedMs: 100,
      gateway: {
        upstream: 'app-reports',
        target: 'target-id',
        address: '10.0.0.2:3000',
        transition: ['UNHEALTHY', 'HEALTHY'],
      },
    },
  });
});

test('a stop failure reports only the final failure after Kong recovery', async () => {
  const fixture = approvalFixture({ exposure: true });
  fixture.state.stopCode = 137;
  expect(await approveArtifact({ ...fixture, kong: new MemoryKong() })).toEqual(
    {
      status: 'rejected',
      unmet: ['Runtime stop exited with 137 instead of 0'],
    },
  );
});

test('a published port reports only the final failure after HTTP recovery', async () => {
  const fixture = approvalFixture();
  fixture.state.publishedPorts = '3000/tcp';
  const probe = fixture.runtime.probe;
  fixture.runtime.probe = (path, timeout) =>
    fixture.clock.now() === 0
      ? Promise.resolve({
          status: 503,
          body: { service: 'reports', status: 'not_ready' },
        })
      : probe(path, timeout);
  expect(await approveArtifact(fixture)).toEqual({
    status: 'rejected',
    unmet: ['Runtime container publishes host ports'],
  });
});

test('Kong ownership inspection can recover before the unhealthy PUT is sent', async () => {
  const result = await runKongApproval('inspection-timeout');
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    verdict: {
      status: 'approved',
      evidence: { gateway: { transition: ['UNHEALTHY', 'HEALTHY'] } },
    },
    mutations: 1,
    inspections: 3,
    cleaned: true,
  });
});

test('Kong mutation response failures cannot be retried or borrow later recovery', async () => {
  const result = await runKongApproval('mutation-response');
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    verdict: { status: 'rejected' },
    mutations: 1,
    inspections: 2,
    cleaned: true,
  });
});

for (const fault of ['droppedMutation', 'changedAddress'] as const)
  test(`artifact approval rejects Kong ${fault}`, async () => {
    const fixture = approvalFixture({ exposure: true });
    const kong = new MemoryKong();
    kong[fault] = true;
    const verdict = await approveArtifact({ ...fixture, kong });
    expect(verdict.status).toBe('rejected');
    expect(fixture.clock.now()).toBe(60_000);
  });

for (const messaging of [false, true])
  test(`artifact approval rejects invalid schema and applicability with messaging=${String(messaging)}`, async () => {
    const fixture = approvalFixture({ messaging });
    const good = fixture.state.snapshot.body as Record<string, unknown>;
    for (const body of [
      null,
      {},
      { ...good, service: 'sibling' },
      { ...good, lifecycle: 'draining' },
      { ...good, http: { status: 'unknown' } },
      { ...good, database: { status: 'ready' } },
      { ...good, consumer: undefined },
      { ...good, publisher: { status: 'unknown' } },
      {
        ...good,
        consumer: messaging ? { status: 'not_applicable' } : readyRole,
      },
      { ...good, consumer: { ...readyRole, connected: false } },
      {
        ...good,
        publisher: {
          ...readyRole,
          status: 'not_ready',
          connected: false,
          reason: 'messaging_unavailable',
        },
      },
    ]) {
      fixture.state.snapshot.body = body;
      const verdict = await approveArtifact(fixture);
      expect(verdict.status).toBe('rejected');
    }
  });

for (const delay of [31_000, 60_001])
  test(`readiness uses one window after slow or overlong responses (${String(delay)} ms)`, async () => {
    const fixture = approvalFixture();
    fixture.state.probeDelay = delay;
    const verdict = await approveArtifact(fixture);
    expect(verdict.status).toBe('rejected');
    expect(fixture.clock.now()).toBeLessThanOrEqual(62_000);
  });
test('the readiness window starts before the runtime container', async () => {
  const fixture = approvalFixture();
  fixture.state.startDelay = 60_000;
  expect((await approveArtifact(fixture)).status).toBe('rejected');
});
test('cancellation surfaces after owned cleanup', async () => {
  const fixture = approvalFixture();
  const cancellation = new AbortController();
  cancellation.abort(new Error('cancelled'));
  await rejects(
    approveArtifact({ ...fixture, signal: cancellation.signal }),
    /cancelled/,
  );
  expect(fixture.state.cleaned).toBe(true);
});
test('cleanup failure cannot produce an approved verdict', async () => {
  const fixture = approvalFixture();
  fixture.state.cleanupFailure = true;
  await rejects(approveArtifact(fixture), /Owned cleanup failed/);
});

test('technical readiness can recover during the original window', async () => {
  const fixture = approvalFixture({ messaging: true });
  const probe = fixture.runtime.probe;
  fixture.runtime.probe = async (path, timeout) =>
    fixture.clock.now() < 2500
      ? { status: 503, body: { service: 'reports', status: 'not_ready' } }
      : probe(path, timeout);
  expect(await approveArtifact(fixture)).toMatchObject({
    status: 'approved',
    evidence: { elapsedMs: 2500 },
  });
});

test('cancellation during a running approval cleans its runtime and surfaces the interruption', async () => {
  const fixture = approvalFixture();
  const cancellation = new AbortController();
  fixture.runtime.probe = () => {
    cancellation.abort(new Error('SIGTERM'));
    return Promise.resolve(fixture.state.http);
  };
  await rejects(
    approveArtifact({ ...fixture, signal: cancellation.signal }),
    /SIGTERM/,
  );
  expect(fixture.state.cleaned).toBe(true);
  expect(fixture.state.running).toBe(false);
});

test('Docker and Kong failures produce rejection conditions, including start failures', async () => {
  const fixture = approvalFixture({ exposure: true });
  const kong = new MemoryKong();
  kong.services = () => Promise.reject(new Error('Kong unavailable'));
  fixture.runtime.executedPlatform = () =>
    Promise.reject(new Error('Docker unavailable'));
  const verdict = await approveArtifact({ ...fixture, kong });
  expect(verdict.status).toBe('rejected');
  if (verdict.status === 'rejected') {
    expect(verdict.unmet.slice(0, 2)).toEqual([
      'Docker unavailable',
      'Kong unavailable',
    ]);
    expect(
      verdict.unmet.filter((condition) => condition === 'Kong unavailable'),
    ).toHaveLength(1);
  }
  fixture.runtime.start = () =>
    Promise.reject(new Error('Container start failed'));
  const started = await approveArtifact(fixture);
  expect(started).toMatchObject({
    status: 'rejected',
    unmet: ['Docker unavailable', 'Container start failed'],
  });
});

test('disabled exposure accepts no gateway entities and rejects invented routes', async () => {
  const fixture = approvalFixture();
  const kong = new MemoryKong();
  kong.upstreamsState = [];
  expect((await approveArtifact({ ...fixture, kong })).status).toBe('approved');
  kong.routesState = [{ id: 'foreign-route', name: 'undeclared' }];
  const verdict = await approveArtifact({ ...fixture, kong });
  expect(verdict.status).toBe('rejected');
  if (verdict.status === 'rejected')
    expect(verdict.unmet[0]).toBe(
      'Kong installed routes do not match declared routing',
    );
});

test('Kong services, route associations and active-check settings must match the declaration', async () => {
  const fixture = approvalFixture({
    exposure: true,
    routes: [
      {
        name: 'create',
        paths: ['/reports'],
        methods: ['POST'],
        stripPath: false,
      },
    ],
  });
  const kong = new MemoryKong();
  kong.servicesState = [
    {
      id: 'service-id',
      name: 'reports--create',
      host: 'app-reports',
      port: 3000,
      protocol: 'http',
      path: null,
      enabled: true,
    },
  ];
  const route = {
    id: 'route-id',
    name: 'reports--create',
    service: { id: 'service-id' },
    paths: ['/reports'],
    methods: ['POST'],
    protocols: ['http', 'https'],
    strip_path: false,
    preserve_host: false,
    path_handling: 'v0',
    regex_priority: 0,
    hosts: null,
    headers: null,
    snis: null,
    sources: null,
    destinations: null,
    request_buffering: true,
    response_buffering: true,
    https_redirect_status_code: 426,
  };
  kong.routesState = [route];
  expect((await approveArtifact({ ...fixture, kong })).status).toBe('approved');
  for (const [override, condition] of [
    [{ service: { id: 'foreign' } }, 'service-id'],
    [{ strip_path: true }, 'strip_path'],
    [{ methods: ['GET'] }, 'differs from declaration'],
    [{ paths: ['/other'] }, 'differs from declaration'],
  ] as const) {
    const invalid = approvalFixture({
      exposure: true,
      routes: fixture.app.routes,
    });
    const invalidKong = new MemoryKong();
    invalidKong.servicesState = kong.servicesState;
    invalidKong.routesState = [{ ...route, ...override }];
    const verdict = await approveArtifact({ ...invalid, kong: invalidKong });
    expect(verdict.status).toBe('rejected');
    if (verdict.status === 'rejected')
      expect(verdict.unmet.join('\n')).toContain(condition);
  }
  const invalid = approvalFixture({
    exposure: true,
    routes: fixture.app.routes,
  });
  const invalidKong = new MemoryKong();
  invalidKong.servicesState = kong.servicesState;
  invalidKong.routesState = [route];
  invalidKong.upstreamsState = [
    { id: 'upstream-id', name: 'app-reports', healthchecks: {} },
  ];
  const verdict = await approveArtifact({ ...invalid, kong: invalidKong });
  expect(verdict.status).toBe('rejected');
  if (verdict.status === 'rejected')
    expect(verdict.unmet.join('\n')).toContain('healthchecks');
});

test('a failed Kong unhealthy mutation cannot borrow a later natural recovery as approval evidence', async () => {
  const fixture = approvalFixture({ exposure: true });
  const kong = new MemoryKong();
  kong.markUnhealthy = () =>
    Promise.reject(new Error('Unhealthy mutation failed'));
  let observed = 0;
  kong.targetHealth = () =>
    Promise.resolve([
      {
        id: 'target-id',
        target: 'app-reports:3000',
        data: {
          addresses: [
            {
              ip: '10.0.0.2',
              port: 3000,
              health: observed++ === 1 ? 'UNHEALTHY' : 'HEALTHY',
            },
          ],
        },
      },
    ]);
  const verdict = await approveArtifact({ ...fixture, kong });
  expect(verdict.status).toBe('rejected');
  if (verdict.status === 'rejected')
    expect(verdict.unmet.join('\n')).toContain('Unhealthy mutation failed');
});

test('a successful stop within the Docker grace tolerates command overhead beyond twenty seconds', async () => {
  const fixture = approvalFixture();
  fixture.state.stopDelay = 21_000;
  expect((await approveArtifact(fixture)).status).toBe('approved');
});
