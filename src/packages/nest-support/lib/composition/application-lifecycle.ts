import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ReadinessSnapshot } from '@starter/capabilities/readiness';
import type { MessagingRole } from './parts';

/** Shared by readiness, signal shutdown and Nest's programmatic close. */
export class ApplicationLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private state: ReadinessSnapshot['lifecycle'] = 'running';
  private stopped?: Promise<void>;

  constructor(private readonly roles: MessagingRole[]) {}

  get current(): ReadinessSnapshot['lifecycle'] {
    return this.state;
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const role of this.roles) await role.start();
  }

  beginDrain(): void {
    if (this.state === 'running') this.state = 'draining';
  }
  beginStop(): void {
    this.state = 'stopping';
  }

  stopMessaging(): Promise<void> {
    this.stopped ??= Promise.all(
      this.roles.map((role) => Promise.resolve().then(() => role.stop())),
    ).then(() => undefined);
    return this.stopped;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.beginDrain();
    await this.stopMessaging();
    this.beginStop();
  }
}
