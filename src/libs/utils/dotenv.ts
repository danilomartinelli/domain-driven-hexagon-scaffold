import { config } from 'dotenv';
import * as path from 'path';

// Commands run from the repository root, whether executing source or built JS.
const envPath: string = path.resolve(
  process.cwd(),
  process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
);
config({ path: envPath });
