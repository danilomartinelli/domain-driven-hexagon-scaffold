import type { InjectionToken } from '@nestjs/common';
import type { ReadinessSnapshot } from '@starter/capabilities/readiness';

/** Injectable read-only view; construction and lifecycle belong to composition. */
export abstract class ApplicationReadiness {
  abstract snapshot(): Promise<ReadinessSnapshot>;
}

/** Handler instances are application-owned; composition knows only their tokens. */
export const MESSAGE_HANDLERS: InjectionToken<unknown> =
  Symbol('MESSAGE_HANDLERS');
