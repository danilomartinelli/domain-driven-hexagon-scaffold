import { Entity } from '../ddd/entity.base';
import { ValueObject } from '../ddd/value-object.base';

function isEntity(obj: unknown): obj is Entity<unknown> {
  /**
   * 'instanceof Entity' causes error here for some reason.
   * Probably creates some circular dependency. This is a workaround
   * until I find a solution :)
   */
  return (
    Object.prototype.hasOwnProperty.call(obj, 'toObject') &&
    Object.prototype.hasOwnProperty.call(obj, 'id') &&
    ValueObject.isValueObject((obj as Entity<unknown>).id)
  );
}

function convertToPlainObject(item: unknown): unknown {
  if (ValueObject.isValueObject(item)) {
    return item.unpack();
  }
  if (isEntity(item)) {
    return item.toObject();
  }
  return item;
}

/**
 * Converts Entity/Value Objects props to a plain object.
 * Useful for testing and debugging.
 * @param props
 */
export function convertPropsToObject<T>(props: T): T {
  const propsCopy = structuredClone(props);

  for (const prop in propsCopy) {
    const value: unknown = propsCopy[prop];
    const converted: unknown = Array.isArray(value)
      ? value.map((item: unknown) => convertToPlainObject(item))
      : value;
    // This utility preserves the existing clone/unpack contract for callers.
    propsCopy[prop] = convertToPlainObject(converted) as T[Extract<
      keyof T,
      string
    >];
  }

  return propsCopy;
}
