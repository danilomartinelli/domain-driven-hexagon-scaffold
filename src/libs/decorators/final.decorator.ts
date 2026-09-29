/** Prevents extending a class marked by this decorator. */
export function final<T extends new (...args: never[]) => object>(
  target: T,
): T {
  const Base: new (...args: never[]) => object = target;
  // The subclass preserves the constructor signature and inherits static members.
  return class Final extends Base {
    constructor(...args: never[]) {
      if (new.target !== Final) {
        throw new Error(`Cannot extend a final class "${target.name}"`);
      }
      super(...args);
    }
  } as unknown as T;
}
