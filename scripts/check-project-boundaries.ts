/** Validate ownership on Nx's resolved graph, including manifest/implicit edges. */
import { runCommand } from './lib/command';

interface Project {
  data: { root: string; tags?: string[] };
}

interface Graph {
  nodes: Record<string, Project | undefined>;
  dependencies: Record<string, { target: string }[]>;
}

async function main(): Promise<number> {
  const result = await runCommand(['bun', 'run', 'nx', 'graph', '--print'], {
    cwd: process.cwd(),
    timeout: 30_000,
    maxOutput: 4_000_000,
  });
  if (result.code !== 0) throw new Error(result.stdout + result.stderr);
  const { graph } = JSON.parse(result.stdout) as { graph: Graph };
  const errors = new Set<string>();
  const tagged = (project: Project, tag: string): boolean =>
    project.data.tags?.includes(tag) ?? false;
  const app = (project: Project): boolean =>
    project.data.root.startsWith('src/apps/');
  const shared = (project: Project): boolean =>
    project.data.root.startsWith('src/packages/');

  for (const [name, project] of Object.entries(graph.nodes)) {
    if (!project) throw new Error(`Nx project ${name} has no metadata`);
    if (
      (app(project) && !tagged(project, 'type:app')) ||
      (shared(project) && !tagged(project, 'scope:shared'))
    ) {
      errors.add(
        `nx-project-classification: ${name} must declare its ownership tags`,
      );
    }
    for (const { target } of graph.dependencies[name] ?? []) {
      const dependency = graph.nodes[target];
      // npm nodes are checked by dependency-cruiser at the source/layer boundary.
      if (!dependency || target === name) continue;
      const edge = `${name} -> ${target}`;
      if (app(dependency))
        errors.add(`nx-app-implementation-is-private: ${edge}`);
      if (shared(project) && !shared(dependency)) {
        errors.add(`nx-shared-is-technical: ${edge}`);
      }
      if (tagged(project, 'type:core') && !tagged(dependency, 'type:core')) {
        errors.add(`nx-core-is-independent: ${edge}`);
      }
      if (
        tagged(project, 'type:contracts') &&
        !tagged(dependency, 'type:contracts')
      ) {
        errors.add(`nx-contracts-are-independent: ${edge}`);
      }
      // Nx includes component tests and explicit runner dependencies. The file
      // rules permit these tooling imports only from the owning app's tests.
      if (
        app(project) &&
        !shared(dependency) &&
        !['database', 'test-runner'].includes(target)
      ) {
        errors.add(`nx-app-dependencies: ${edge}`);
      }
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): void => {
    if (active.has(name)) {
      errors.add(
        `nx-no-circular: ${[...path.slice(path.indexOf(name)), name].join(' -> ')}`,
      );
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    active.add(name);
    path.push(name);
    for (const { target } of graph.dependencies[name] ?? []) {
      if (graph.nodes[target] && target !== name) visit(target);
    }
    path.pop();
    active.delete(name);
  };
  for (const name of Object.keys(graph.nodes)) visit(name);

  for (const error of errors) console.error(`error ${error}`);
  if (errors.size) return 1;
  console.log('Nx project boundaries passed.');
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
