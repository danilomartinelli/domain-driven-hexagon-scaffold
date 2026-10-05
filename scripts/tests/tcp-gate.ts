import { createConnection, createServer, type Socket } from 'node:net';

/**
 * An owned TCP gate that counts connection attempts and forwards bytes only
 * while allowed. Without a target it is a sentinel that nothing should reach.
 * It never stops the real service behind it.
 */
export async function tcpGate(target?: {
  hostname: string;
  port: number;
}): Promise<{
  port: string;
  attempts(): number;
  allow(): void;
  block(): void;
  close(): Promise<void>;
}> {
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
    track(client);
    if (!online || !target) {
      client.destroy();
      return;
    }
    const upstream = createConnection({
      host: target.hostname,
      port: target.port,
    });
    track(upstream);
    for (const socket of [client, upstream])
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
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
