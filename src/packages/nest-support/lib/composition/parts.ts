import type {
  FactoryProvider,
  InjectionToken,
  ModuleMetadata,
} from '@nestjs/common';

export interface MessagingRole {
  start(): void | Promise<void>;
  stop(): Promise<void>;
  snapshot(): {
    connected: boolean;
    failures: number;
    retries: number;
    retryDelayMs: number;
    lastFailureAt: string | null;
  };
}

type SourceFactory<T> = Pick<FactoryProvider<T>, 'inject' | 'useFactory'>;
export type BacklogSource = () => Promise<{
  pendingCount: number;
  oldestAgeSeconds: number | null;
}>;
export type DatabaseProbe = () => Promise<void>;

/** Nest adapters and providers owned by one prepared integration or group. */
export interface ApplicationPart extends Pick<
  ModuleMetadata,
  'imports' | 'controllers' | 'providers'
> {
  database?: never;
  handlers?: InjectionToken[];
  backlog?: SourceFactory<BacklogSource>;
  consumer?: InjectionToken<MessagingRole>;
  publisher?: InjectionToken<MessagingRole>;
}

export interface PersistencePart extends Omit<ApplicationPart, 'database'> {
  database: SourceFactory<DatabaseProbe>;
}

type PartFactory<Part> = () => Part | Promise<Part>;
export interface ApplicationFactories {
  integrations: {
    persistence?: PartFactory<PersistencePart>;
    messaging?: PartFactory<ApplicationPart>;
    exposure?: PartFactory<ApplicationPart>;
  };
  groups: Record<string, PartFactory<ApplicationPart>>;
}
