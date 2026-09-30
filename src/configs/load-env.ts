import { config } from 'dotenv';
import * as path from 'path';

// Commands run from the repository root, executing source directly under Bun.
const envPath: string = path.resolve(
  process.cwd(),
  process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
);
// dotenv 18 logs by default; keep database command output free of its banner.
config({ path: envPath, quiet: true });
