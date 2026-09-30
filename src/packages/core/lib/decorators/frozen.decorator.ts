/**
 * Applies Object.freeze() to a class and it's prototype.
 * Does not freeze all the properties of a class created
 * using 'new' keyword, only static properties and prototype
 * of a class.
 */
export function frozen(constructor: { readonly prototype: object }): void {
  Object.freeze(constructor);
  Object.freeze(constructor.prototype);
}
