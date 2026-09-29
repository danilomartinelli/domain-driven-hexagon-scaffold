/**
 * Clone properties for snapshots without sharing mutable nested data.
 * structuredClone preserves dates and data, but strips class prototypes.
 * Nested Entity/ValueObject instances retain their stored-property shape;
 * this helper does not invoke their serialization methods.
 */
export function convertPropsToObject<T>(props: T): T {
  return structuredClone(props);
}
