import { Logger, type INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { ServiceHealth } from './service-health';

/** Own signal handling before Nest closes transports or invokes database hooks. */
export function installShutdown(
  app: INestApplication,
  stopMessaging: () => Promise<void>,
): void {
  const health = app.get(ServiceHealth);
  const logger = new Logger('Shutdown');
  const requests = new Set<Promise<void>>();
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path.startsWith('/health/')) {
      next();
      return;
    }
    if (health.lifecycle !== 'running') {
      response.setHeader('Connection', 'close');
      response
        .status(503)
        .json({ status: 'not_ready', reason: health.lifecycle });
      return;
    }
    const finished = Promise.withResolvers<undefined>();
    requests.add(finished.promise);
    const finish = () => {
      requests.delete(finished.promise);
      finished.resolve(undefined);
    };
    response.once('finish', finish);
    response.once('close', finish);
    next();
  });

  const shutdown = (signal: string) => {
    if (health.lifecycle !== 'running') return;
    health.lifecycle = 'draining';
    const started = Date.now();
    const metadata = { service: health.service, signal, deadlineMs: 15_000 };
    logger.log('Shutdown started; refusing new work.', {
      ...metadata,
      operation: 'shutdown.started',
    });
    // Keep the deadline even after app.close(): leaked handles must not turn a
    // bounded stop into a hung process. An unref timer permits natural exit.
    const deadline = setTimeout(() => {
      logger.error('Shutdown timed out; unfinished work requires recovery.', {
        ...metadata,
        operation: 'shutdown.timed_out',
      });
      process.exit(1);
    }, 15_000);
    deadline.unref();
    void (async () => {
      await Promise.all([stopMessaging(), ...requests]);
      health.lifecycle = 'stopping';
      await app.close();
      process.once('beforeExit', () => {
        clearTimeout(deadline);
        logger.log('Shutdown completed; owned handles closed.', {
          ...metadata,
          operation: 'shutdown.completed',
          elapsedMs: Date.now() - started,
        });
        // Bun's --watch keeps an otherwise empty process alive.
        process.exit();
      });
    })().catch((error: unknown) => {
      logger.error(
        'Shutdown failed; unfinished work requires recovery.',
        error,
        {
          ...metadata,
          operation: 'shutdown.failed',
        },
      );
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}
