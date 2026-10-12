import { z } from 'zod';
import { applicationDeclarationSchema } from '@starter/capabilities/declaration';

const port = z.number().int().min(1).max(65535);
const targetSchema = z.object({
  app: z.string(),
  prefix: z.string(),
  host: z.literal('127.0.0.1'),
  port,
  /** Owner role: migration authority, and the application's role when no runtime role is registered. */
  username: z.string(),
  password: z.string(),
  database: z.string(),
  // Recorded when first provisioned; older manifests are completed on read.
  service: z.string().optional(),
  /** Development storage; test databases use tmpfs. */
  volume: z.string().optional(),
  runtime: z.object({ username: z.string(), password: z.string() }).optional(),
});
export const manifestSchema = z.object({
  environment: z.enum(['test', 'development']),
  run: z.string(),
  project: z.string(),
  owner: z.uuid(),
  status: z.enum(['starting', 'ready', 'stopped']),
  // Resource inventory survives declaration removal and capability disablement.
  databases: z.array(targetSchema),
  apps: z.array(z.string()).optional(),
  topology: z.array(applicationDeclarationSchema).optional(),
  applicationPorts: z.record(z.string(), port).default({}),
  broker: z
    .object({
      port,
      managementPort: port,
      username: z.string(),
      password: z.string(),
      vhost: z.string(),
      /** Development storage; test brokers use tmpfs. */
      volume: z.string().optional(),
    })
    .optional(),
  gateway: z
    .object({
      name: z.string(),
      host: z.string(),
      proxyPort: port,
      adminPort: port,
      // Read compatibility for manifests created before declaration-derived ports.
      userPort: port.optional(),
      walletPort: port.optional(),
    })
    .optional(),
});
/** A manifest as recorded, possibly before service and volume names were recorded. */
export type RecordedManifest = z.infer<typeof manifestSchema>;
/** A manifest whose owned identities are all recorded. */
export type EnvironmentManifest = Omit<RecordedManifest, 'databases'> & {
  databases: (RecordedManifest['databases'][number] & { service: string })[];
};
export type EnvironmentKind = EnvironmentManifest['environment'];
