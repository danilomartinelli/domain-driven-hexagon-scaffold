/** Prevents extending a class marked by this decorator. */
export function final<Args extends unknown[], Instance extends object>(
  target: new (...args: Args) => Instance,
): new (...args: Args) => Instance {
  const Base: new (...args: Args) => object = target;
  return class Final extends Base {
    constructor(...args: Args) {
      if (new.target !== Final) {
        throw new Error(`Cannot extend a final class "${target.name}"`);
      }
      super(...args);
    }
  } as new (...args: Args) => Instance;
}
