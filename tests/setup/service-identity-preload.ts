import { Server, ServerResponse } from 'node:http';

const identity = process.env.STARTER_TEST_HTTP_IDENTITY;
if (!identity) throw new Error('Missing test service HTTP identity');

// Only test-spawned applications load this adapter. Tag responses at the HTTP
// server boundary without changing production routes or application modules.
// eslint-disable-next-line @typescript-eslint/unbound-method -- Forward the server receiver explicitly with Reflect.apply below.
const emit = Server.prototype.emit;
Server.prototype.emit = function (
  event: string | symbol,
  ...args: unknown[]
): boolean {
  const response = args[1];
  if (event === 'request' && response instanceof ServerResponse) {
    response.setHeader('x-starter-test-instance', identity);
  }
  return Reflect.apply(emit, this, [event, ...args]) === true;
};
