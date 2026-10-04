import { generateLibrary } from './library.mjs';

/** @param {import('@nx/devkit').Tree} tree
 * @param {import('./library.mjs').LibraryOptions} options
 * @returns {Promise<() => void>}
 */
export default function tsLib(tree, options) {
  return generateLibrary(tree, options, 'core');
}
