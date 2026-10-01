-- User owns this distinct fixture; only its pending event will create its Wallet.
INSERT INTO
  users (
    id,
    "createdAt",
    "updatedAt",
    email,
    country,
    "postalCode",
    street,
    "role"
  )
VALUES
  (
    'a73b6bf6-6077-4117-a6b3-dff3e02f2310',
    now(),
    now(),
    'john@gmail.com',
    'England',
    '24312',
    'Road Avenue',
    'guest'
  );
INSERT INTO user_outbox (event_id, envelope) VALUES (
  'f6755c04-b1f8-4463-bd4a-6fe00281bda9',
  jsonb_build_object(
    'type', 'user.created', 'version', 1, 'source', 'user',
    'eventId', 'f6755c04-b1f8-4463-bd4a-6fe00281bda9',
    'occurredAt', '2026-09-30T12:00:00.000Z',
    'correlationId', 'user-seed', 'causationId', 'user-seed',
    'data', jsonb_build_object('userId', 'a73b6bf6-6077-4117-a6b3-dff3e02f2310')
  )
);
