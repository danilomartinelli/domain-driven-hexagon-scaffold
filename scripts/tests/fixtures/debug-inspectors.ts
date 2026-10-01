import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';

const projectSchema = z.object({
  targets: z.object({
    debug: z.object({ options: z.object({ command: z.string() }) }),
  }),
});
const commands = await Promise.all(
  ['user', 'wallet'].map(async (app) => {
    const project = projectSchema.parse(
      await Bun.file(`src/apps/${app}/project.json`).json(),
    );
    return project.targets.debug.options.command;
  }),
);
let output = '';
// Keep the real debug commands in runCommand's process group. Forward every
// chunk so its output bound also applies to this interactive fixture's workload.
const children = commands.map((command) => {
  const child = spawn('sh', ['-c', `exec ${command}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });
  child.once('error', (error) => {
    output += error.message;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    output += stripVTControlCharacters(chunk.toString());
  });
  return { child, closed };
});

async function connect(url: string): Promise<void> {
  const socket = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(`Inspector connection timed out: ${url}`));
      }, 2_000);
      socket.onopen = (): void => {
        clearTimeout(deadline);
        resolve();
      };
      socket.onerror = (): void => {
        clearTimeout(deadline);
        reject(new Error(`Cannot connect to advertised inspector: ${url}`));
      };
    });
  } finally {
    socket.close();
  }
}

try {
  const deadline = Date.now() + 10_000;
  let urls: string[] = [];
  while (Date.now() < deadline) {
    urls = [...new Set(output.match(/ws:\/\/\S+(?=\s)/g))];
    if (
      urls.length === 2 ||
      children.some(({ child }) => child.exitCode !== null)
    )
      break;
    await Bun.sleep(20);
  }
  assert.equal(urls.length, 2, `Expected both inspectors to start:\n${output}`);
  const results = await Promise.allSettled(urls.map(connect));
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [String(result.reason)] : [],
  );
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Connected to both advertised inspectors');
} finally {
  for (const { child } of children) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const { child } of children) child.kill('SIGKILL');
  }, 2_000);
  try {
    await Promise.all(children.map(({ closed }) => closed));
  } finally {
    clearTimeout(deadline);
  }
}
