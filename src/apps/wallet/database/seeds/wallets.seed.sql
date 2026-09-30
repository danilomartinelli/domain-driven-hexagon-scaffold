-- Lookup example for the seeded john@gmail.com User identity. This insert is
-- the fixture's only source: no user-created event is scheduled to create it.
INSERT INTO
  wallets (id, "createdAt", "updatedAt", balance, "userId")
VALUES
  (
    'cb235df6-d2af-4b75-8b6e-f9b75559392a',
    now(),
    now(),
    0,
    'f59d0748-d455-4465-b0a8-8d8260b1c877'
  );
