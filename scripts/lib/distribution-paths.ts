import { existsSync } from 'node:fs';
import path from 'node:path';

export function containsPath(
  root: string,
  candidate: string,
  paths = path,
): boolean {
  const within = paths.relative(root, candidate);
  return (
    within !== '..' &&
    !within.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(within)
  );
}

/** Resolve installed packages by location, retaining nested versions from the frozen install. */
export function installedPackage(
  root: string,
  name: string,
  from: string,
  paths = path,
  exists: (file: string) => boolean = existsSync,
): string | undefined {
  let directory = from;
  while (containsPath(root, directory, paths)) {
    const candidate = paths.join(directory, 'node_modules', name);
    if (exists(paths.join(candidate, 'package.json'))) return candidate;
    if (paths.relative(root, directory) === '') break;
    directory = paths.dirname(directory);
  }
  return undefined;
}

export function packageInstallPath(
  root: string,
  installed: string,
  paths = path,
): string {
  const installedPath = paths.relative(root, installed);
  const segments = installedPath.split(paths.sep);
  return segments[0] === 'src' &&
    segments[1] === 'packages' &&
    segments[3] === 'node_modules'
    ? paths.join('node_modules', '@starter', ...segments.slice(2))
    : installedPath;
}
