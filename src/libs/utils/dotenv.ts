import { config } from 'dotenv';
import * as path from 'path';

// Commands run from the repository root, executing source directly under Bun.
const envPath: string = path.resolve(
  process.cwd(),
  process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
);
config({ path: envPath });
