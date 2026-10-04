import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCommand } from './command';

const targetSchema = z.object({
  cache: z.boolean().optional(),
  inputs: z.array(z.unknown()).optional(),
  options: z.object({ command: z.string().optional() }).optional(),
});

const graphSchema = z.object({
  graph: z.object({
    nodes: z.record(
      z.string(),
      z.object({
        data: z.object({
          root: z.string(),
          tags: z.array(z.string()).optional(),
          targets: z.record(z.string(), targetSchema).optional(),
        }),
      }),
    ),
    dependencies: z.record(
      z.string(),
      z.array(z.object({ target: z.string(), type: z.string() })),
    ),
  }),
});

export type ProjectGraph = z.infer<typeof graphSchema>['graph'];

/**
 * Nx's resolved project graph, including target defaults. `isolated` keeps
 * Nx's workspace data and cache in a temporary directory, so checks that only
 * read the graph leave the checkout's graph and task caches untouched.
 */
export async function readProjectGraph(
  root: string,
  { env = process.env, isolated = false } = {},
): Promise<ProjectGraph> {
  const data = isolated
    ? await mkdtemp(join(tmpdir(), 'ddh-nx-graph-'))
    : undefined;
  try {
    const result = await runCommand(
      [process.execPath, 'run', 'nx', 'graph', '--print'],
      {
        cwd: root,
        timeout: 30_000,
        maxOutput: 4_000_000,
        env: data
          ? {
              ...env,
              NX_WORKSPACE_DATA_DIRECTORY: data,
              NX_CACHE_DIRECTORY: join(data, 'cache'),
            }
          : env,
      },
    );
    if (result.code !== 0) throw new Error(result.stdout + result.stderr);
    return graphSchema.parse(JSON.parse(result.stdout)).graph;
  } finally {
    if (data) await rm(data, { recursive: true, force: true });
  }
}
