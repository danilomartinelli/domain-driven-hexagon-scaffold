import process from 'node:process';

// Run in the service child, after the parent's port check but before app import.
// A separate process owns the listener, so child identity cannot authenticate it.
const foreign = Bun.spawn(
  [
    process.execPath,
    '--no-env-file',
    '-e',
    `const server = Bun.serve({
    hostname: '127.0.0.1', port: Number(process.env.USER_HTTP_PORT),
    fetch: () => new Response('foreign'),
  });
  process.on('SIGTERM', () => { server.stop(true); process.exit(0); });`,
  ],
  { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
);
process.on('SIGTERM', () => {
  foreign.kill('SIGTERM');
  void foreign.exited.then(() => {
    process.exit(0);
  });
});
await foreign.exited;
throw new Error('Foreign listener exited before fixture shutdown');
