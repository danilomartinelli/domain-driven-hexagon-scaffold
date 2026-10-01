import { expect } from 'bun:test';
import { ApiErrorResponse } from '@starter/nest-support/http';
import { TestContext } from '../test-utils/TestContext';
import type { CreateUserTestContext } from '../user/user-shared-steps';
import type { DefineStepFunction } from 'jest-cucumber';

/**
 * Test steps that can be shared between all tests
 */

export const iReceiveAnErrorWithStatusCode = (
  then: DefineStepFunction,
  ctx: TestContext<CreateUserTestContext>,
): void => {
  then(
    /^I receive an error "(.*)" with status code (\d+)$/,
    (errorMessage: string, statusCode: string) => {
      const apiError = ctx.latestResponse as ApiErrorResponse;
      expect(apiError.statusCode).toBe(parseInt(statusCode));
      expect(apiError.error).toBe(errorMessage);
    },
  );
};
