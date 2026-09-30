import { SchemaValidationError } from 'slonik';
import type { Interceptor, QueryResultRow } from 'slonik';

/** sql.type carries a schema; Slonik requires an interceptor to validate rows. */
export const resultParser: Interceptor = {
  name: 'result-parser',
  async transformRowAsync(context, query, row) {
    if (!context.resultParser) return row;

    const result = await context.resultParser['~standard'].validate(row);
    if (result.issues) {
      throw new SchemaValidationError(query, row, result.issues);
    }
    // Slonik's interceptor type describes raw columns; schemas may coerce dates.
    return result.value as QueryResultRow;
  },
};
