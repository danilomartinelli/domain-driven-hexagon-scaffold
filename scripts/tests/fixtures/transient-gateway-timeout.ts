import { spyOn } from 'bun:test';
import pg from 'pg';
import { readEnvironmentFile } from '../../../database/environment';

const fetch = globalThis.fetch;
let injected = false;
let observedHttp = false;

function fetchWithInitialTimeout(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  if (
    !injected &&
    typeof input === 'string' &&
    input.endsWith('/user/graphql')
  ) {
    injected = true;
    const signal = init?.signal;
    if (!signal) throw new Error('The gateway request must have a deadline');
    return new Promise<Response>((_resolve, reject) => {
      const expire = () => {
        console.log('Injected one application-owned gateway request timeout');
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      if (signal.aborted) expire();
      else signal.addEventListener('abort', expire, { once: true });
    });
  }
  return fetch(input, init).then(async (response) => {
    if (
      !observedHttp &&
      typeof input === 'string' &&
      input.endsWith('/user/graphql') &&
      response.status === 200
    ) {
      observedHttp = true;
      const file = process.env.DDH_ENVIRONMENT_FILE;
      if (!file) throw new Error('Missing owned manifest');
      const database = readEnvironmentFile(file).databases[0];
      const owner = new pg.Client({
        host: database.host,
        port: database.port,
        database: database.database,
        user: database.username,
        password: database.password,
      });
      try {
        await owner.connect();
        const tables = await owner.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        );
        if (tables.rows.length === 0)
          console.log(
            'Observed usable application-owned HTTP before migrations',
          );
      } finally {
        await owner.end();
      }
    }
    return response;
  });
}

spyOn(globalThis, 'fetch').mockImplementation(
  Object.assign(fetchWithInitialTimeout, { preconnect: fetch.preconnect }),
);
