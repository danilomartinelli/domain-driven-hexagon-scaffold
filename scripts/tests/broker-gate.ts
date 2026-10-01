import { createServer, createConnection, type Socket } from 'node:net';

/** An owned TCP gate in front of the real broker; never stops shared Docker services. */
export async function brokerGate(target: {
  hostname: string;
  port: number;
}): Promise<{
  port: string;
  attempts(): number;
  allow(): void;
  withholdConfirmations(): void;
  releaseConfirmations(): void;
  confirmations(): number;
  block(): void;
  close(): Promise<void>;
}> {
  let online = false;
  let withhold = false;
  let confirmations = 0;
  let attempts = 0;
  const sockets = new Set<Socket>();
  const heldConfirmations = new Map<Socket, Buffer[]>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      heldConfirmations.delete(socket);
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
    client.pipe(upstream);
    let buffered = Buffer.alloc(0);
    upstream.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 7) {
        const size = buffered.readUInt32BE(3) + 8;
        if (buffered.length < size) break;
        const frame = buffered.subarray(0, size);
        buffered = buffered.subarray(size);
        const confirmation =
          frame[0] === 1 &&
          frame.length >= 12 &&
          frame.readUInt16BE(7) === 60 &&
          [80, 120].includes(frame.readUInt16BE(9));
        if (confirmation) confirmations++;
        if (withhold && confirmation) {
          const pending = heldConfirmations.get(client) ?? [];
          pending.push(frame);
          heldConfirmations.set(client, pending);
        } else client.write(frame);
      }
    });
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
    withholdConfirmations: () => {
      withhold = true;
    },
    confirmations: () => confirmations,
    releaseConfirmations: () => {
      withhold = false;
      for (const [client, frames] of heldConfirmations) {
        if (!client.destroyed) for (const frame of frames) client.write(frame);
      }
      heldConfirmations.clear();
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
