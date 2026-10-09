import { Logger, type INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { ServiceHealth } from './service-health';
import { ApplicationLifecycle } from '../composition/application-lifecycle';

/**
 * Own signal handling before Nest invokes database shutdown hooks.
 * The composed module supplies the messaging roles to drain first.
 */
export function installShutdown(app: INestApplication): void {
  const health = app.get(ServiceHealth);
  const lifecycle = app.get(ApplicationLifecycle);
  const logger = new Logger('Shutdown');
  const requests = new Set<Promise<void>>();
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path.startsWith('/health/')) {
      next();
      return;
    }
    if (lifecycle.current !== 'running') {
      response.setHeader('Connection', 'close');
      response
        .status(503)
        .json({ status: 'not_ready', reason: lifecycle.current });
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
    if (lifecycle.current !== 'running') return;
    lifecycle.beginDrain();
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
      await Promise.all([lifecycle.stopMessaging(), ...requests]);
      lifecycle.beginStop();
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
