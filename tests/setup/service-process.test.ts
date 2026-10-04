import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { availablePort } from '../../scripts/lib/environments';
import { withCleanup } from '../../scripts/tests/cleanup';
import { ServiceProcess } from './service-process';

test('rejects a foreign HTTP response when the port is occupied during child startup', async () => {
  const port = await availablePort();
  const previous = process.env.USER_HTTP_PORT;
  process.env.USER_HTTP_PORT = String(port);
  const service = new ServiceProcess('user');
  await withCleanup(async () => {
    const error = await service
      .start(
        new URL('./fixtures/occupied-during-startup.ts', import.meta.url)
          .pathname,
      )
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: `user HTTP port ${String(port)} answered from another process; retry with a fresh test environment.`,
    });
  }, [
    () => service.stop(),
    () => {
      if (previous === undefined) delete process.env.USER_HTTP_PORT;
      else process.env.USER_HTTP_PORT = previous;
    },
  ]);
  const response = await fetch(`http://127.0.0.1:${String(port)}`).catch(
    () => undefined,
  );
  expect(response).toBeUndefined();
});

test.each(['127.0.0.1', '0.0.0.0'])(
  'rejects an HTTP port occupied on %s after allocation, even if its docs probe returns 200',
  async (host) => {
    const port = await availablePort();
    const server = createServer((_request, response) =>
      response.end('foreign'),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const previous = process.env.USER_HTTP_PORT;
    process.env.USER_HTTP_PORT = String(port);
    const service = new ServiceProcess('user');
    await withCleanup(async () => {
      const error = await service.start().then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: `user HTTP port ${String(port)} is unavailable; retry with a fresh test environment.`,
      });
      expect(await (await fetch(service.url)).text()).toBe('foreign');
    }, [
      () => service.stop(),
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        ),
      () => {
        if (previous === undefined) delete process.env.USER_HTTP_PORT;
        else process.env.USER_HTTP_PORT = previous;
      },
    ]);
  },
);
