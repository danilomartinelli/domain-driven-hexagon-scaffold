import { config } from 'dotenv';
import { resolve } from 'node:path';

// Outside a selected environment, legacy workflows read the root .env, or
// .env.test when NODE_ENV=test; shell values win. Commands run from the
// repository root. dotenv 18 logs by default; keep command output readable.
if (!process.env.DDH_ENVIRONMENT_FILE)
  config({
    path: resolve(
      process.cwd(),
      process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
    ),
    quiet: true,
  });
