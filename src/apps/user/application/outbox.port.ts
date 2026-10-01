export interface PendingPublication {
  readonly eventId: string;
  readonly correlationId: string;
  readonly body: string;
}

export interface UserOutbox {
  /** Claims committed work, recording completion only after publish resolves. */
  publishNext(
    publish: (event: PendingPublication) => Promise<void>,
  ): Promise<boolean>;
}
