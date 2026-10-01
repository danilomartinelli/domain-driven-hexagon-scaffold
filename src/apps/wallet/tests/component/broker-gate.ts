import { createServer, createConnection, type Socket } from 'node:net';
import { brokerOptions } from './broker-fixture';

/** An owned TCP gate in front of the real broker; never stops shared Docker services. */
export async function brokerGate(): Promise<{
  port: string;
  attempts(): number;
  allow(): void;
  block(): void;
  close(): Promise<void>;
}> {
  const target = brokerOptions();
  let online = false;
  let attempts = 0;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  };
  const server = createServer((client) => {
    attempts++;
    if (!online) {
      client.destroy();
      return;
    }
    const upstream = createConnection({
      host: target.hostname,
      port: target.port,
    });
    for (const socket of [client, upstream]) {
      track(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.on('close', () => {
      upstream.destroy();
    });
    upstream.on('close', () => {
      client.destroy();
    });
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing TCP gate address');
  const block = () => {
    online = false;
    for (const socket of sockets) socket.destroy();
  };
  return {
    port: String(address.port),
    attempts: () => attempts,
    allow: () => {
      online = true;
    },
    block,
    close: async () => {
      block();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
