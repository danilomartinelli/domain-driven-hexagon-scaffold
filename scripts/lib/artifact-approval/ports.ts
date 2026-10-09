import type { EnvironmentManifest } from '../../../database/environment';

export interface ApprovalClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
export interface PlatformImageRuntime {
  executedPlatform: () => Promise<{ platform: string; arch: string }>;
  migrate: (
    action: string,
    overrides?: Record<string, string>,
  ) => Promise<{ code: number; stderr: string }>;
  start: (timeout: number) => Promise<void>;
  publishedPorts: (timeout: number) => Promise<string>;
  hostReachable: (timeout: number) => Promise<boolean>;
  probe: (
    path: string,
    timeout: number,
  ) => Promise<{ status: number; body: unknown }>;
  stop: () => Promise<{ code: number }>;
  cleanup: () => Promise<void>;
}
export interface KongEntity {
  id: string;
  name: string;
  [field: string]: unknown;
}
export interface KongTarget {
  id: string;
  target: string;
  data: { addresses: { ip: string; port: number; health: string }[] };
}
/** The adapter guarantees that no mutation request was sent, so retry is safe. */
export class KongMutationNotSentError extends Error {}

export interface KongAdmin {
  install(configuration: string, timeout: number): Promise<void>;
  services(timeout: number): Promise<KongEntity[]>;
  routes(timeout: number): Promise<KongEntity[]>;
  upstreams(timeout: number): Promise<KongEntity[]>;
  targetHealth(upstream: string, timeout: number): Promise<KongTarget[]>;
  markUnhealthy(
    upstream: string,
    target: string,
    timeout: number,
  ): Promise<void>;
}
export type ApprovalEnvironment = Pick<
  EnvironmentManifest,
  'environment' | 'topology' | 'applicationPorts' | 'gateway'
>;

export type GatewayEvidence = {
  upstream: string;
  target: string;
  address: string;
  transition: ['UNHEALTHY', 'HEALTHY'];
};
