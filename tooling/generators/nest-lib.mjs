import { generateLibrary } from './library.mjs';

/** @param {import('@nx/devkit').Tree} tree
 * @param {import('./library.mjs').LibraryOptions} options
 * @returns {Promise<() => void>}
 */
export default function nestLib(tree, options) {
  return generateLibrary(tree, options, options.layer ?? 'adapter');
}
