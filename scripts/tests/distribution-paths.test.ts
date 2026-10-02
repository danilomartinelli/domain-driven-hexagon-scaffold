import { expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import {
  containsPath,
  installedPackage,
  packageInstallPath,
} from '../lib/distribution-paths';

for (const [platform, paths, root] of [
  ['POSIX', posix, '/workspace'],
  ['Windows', win32, 'C:\\workspace'],
  ['Windows UNC', win32, '\\\\server\\share\\workspace'],
] as const) {
  test(`${platform}: containment respects path boundaries`, () => {
    expect(containsPath(root, paths.join(root, 'node_modules'), paths)).toBe(
      true,
    );
    expect(containsPath(root, `${root}-other`, paths)).toBe(false);
    expect(containsPath(root, paths.dirname(root), paths)).toBe(false);
    expect(containsPath(root, paths.join(root, '..cache'), paths)).toBe(true);
    if (paths === win32) {
      expect(containsPath(root, 'D:\\other', paths)).toBe(false);
      expect(containsPath(root, root.toUpperCase(), paths)).toBe(true);
    }
  });
  test(`${platform}: dependency lookup reaches nested, hoisted and private-package dependencies`, () => {
    for (const owner of [
      'node_modules/.bun/parent@1/node_modules/parent',
      'src/packages/core',
    ]) {
      const from = paths.join(root, owner);
      for (const directory of [from, paths.dirname(from), root]) {
        const dependency = paths.join(directory, 'node_modules', 'child');
        const visited: string[] = [];
        const found = installedPackage(root, 'child', from, paths, (file) => {
          visited.push(file);
          return file === paths.join(dependency, 'package.json');
        });
        expect(found).toBe(dependency);
        expect(visited.at(-1)).toBe(paths.join(dependency, 'package.json'));
      }
    }
  });

  test(`${platform}: private aliases remain in the artifact dependency tree`, () => {
    const installed = paths.join(
      root,
      'src/packages/core/node_modules/@scope/child',
    );
    expect(packageInstallPath(root, installed, paths)).toBe(
      paths.join('node_modules/@starter/core/node_modules/@scope/child'),
    );
    const external = 'node_modules/.bun/child@1/node_modules/child';
    expect(packageInstallPath(root, paths.join(root, external), paths)).toBe(
      paths.normalize(external),
    );
  });

  test(`${platform}: lookup never escapes into ancestor or similarly named sibling dependencies`, () => {
    const visited: string[] = [];
    const missing = installedPackage(
      root,
      'missing',
      paths.join(root, 'src/packages/core'),
      paths,
      (file) => {
        visited.push(file);
        return false;
      },
    );
    expect(missing).toBeUndefined();
    expect(visited.at(-1)).toBe(
      paths.join(root, 'node_modules/missing/package.json'),
    );
    expect(
      installedPackage(root, 'child', `${root}-other`, paths, () => true),
    ).toBeUndefined();
  });
}
