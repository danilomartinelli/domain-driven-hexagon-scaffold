import { DeleteUserCommand } from '@modules/user/commands/delete-user/delete-user.command';
import { expect, test } from 'bun:test';
import { Command } from '@libs/ddd';
import { CreateUserCommand } from '@modules/user/commands/create-user/create-user.command';

test('commands retain explicit identity and tracing metadata without a request context', () => {
  const command = new CreateUserCommand({
    id: 'operation-1',
    metadata: {
      correlationId: 'correlation-1',
      causationId: 'parent-1',
      userId: 'actor-1',
      timestamp: 0,
    },
    email: 'alice@example.com',
    country: 'England',
    street: 'Baker street',
    postalCode: 'NW1',
  });
  expect(command).toBeInstanceOf(Command);
  expect(command.id).toBe('operation-1');
  expect(command.metadata).toEqual({
    correlationId: 'correlation-1',
    causationId: 'parent-1',
    userId: 'actor-1',
    timestamp: 0,
  });
  expect(command.email).toBe('alice@example.com');
});

test('DeleteUserCommand is a plain input that retains its target and operation', () => {
  const command = new DeleteUserCommand({
    userId: 'user-1',
    id: 'delete-1',
    metadata: { correlationId: 'correlation-1', timestamp: 0 },
  });
  expect(command.userId).toBe('user-1');
  expect(command.id).toBe('delete-1');
  expect(command.metadata.correlationId).toBe('correlation-1');
});
