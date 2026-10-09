import { workspaceRoot } from '../../database/environment';
import { readProjectGraph } from './nx-graph';

/** Optional application-owned scenarios, resolved from Nx after artifact approval. */
export async function distributionScenarioCommand(
  application: string,
): Promise<string[] | undefined> {
  const graph = await readProjectGraph(workspaceRoot);
  const project = Object.entries(graph.nodes).find(
    ([, node]) => node.data.root === `src/apps/${application}`,
  );
  if (!project?.[1].data.targets?.['test-distribution']) return undefined;
  return ['bun', 'run', 'nx', 'run', `${project[0]}:test-distribution`];
}
