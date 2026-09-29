import type { Command } from '@starter/core/domain';
import { randomUUID } from 'node:crypto';

/** Transport adapters supply correlation; commands do not read ambient state. */
export function createCommandContext(
  correlationId: string = randomUUID(),
): Pick<Command, 'id' | 'metadata'> {
  return {
    id: randomUUID(),
    metadata: { correlationId, timestamp: Date.now() },
  };
}
