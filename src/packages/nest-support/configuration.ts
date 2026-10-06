import { readFileSync } from 'node:fs';

/** Read a process setting or its mounted secret; errors never include values or file paths. */
export function configurationValue(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment[name];
  const file = environment[`${name}_FILE`];
  if (file === undefined) return value;
  if (value !== undefined) throw new Error(`Choose ${name} or ${name}_FILE`);
  let content: string;
  try {
    content = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch {
    throw new Error(`Cannot read ${name}_FILE`);
  }
  if (!content) throw new Error(`Empty ${name}_FILE`);
  return content;
}
