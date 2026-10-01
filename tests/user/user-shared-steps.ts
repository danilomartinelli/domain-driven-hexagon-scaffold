import type { Mutable } from '@starter/core/types';
import type { CreateUserRequestDto } from '@tests/test-utils/ApiClient';
import type { DefineStepFunction } from 'jest-cucumber';
import { TestContext } from '@tests/test-utils/TestContext';
import { ApiClient } from '@tests/test-utils/ApiClient';

/**
 * Test steps that are shared between multiple user tests
 */

export type CreateUserTestContext = {
  createUserDto: Mutable<CreateUserRequestDto>;
};

export const givenUserProfileData = (
  given: DefineStepFunction,
  ctx: TestContext<CreateUserTestContext>,
): void => {
  given(/^user profile data$/, (table: CreateUserRequestDto[]) => {
    ctx.context.createUserDto = table[0];
  });
};

export const iSendARequestToCreateAUser = (
  when: DefineStepFunction,
  ctx: TestContext<CreateUserTestContext>,
): void => {
  when('I send a request to create a user', async () => {
    const dto = ctx.context.createUserDto;
    if (!dto) throw new Error('User profile data has not been provided.');
    const response = await new ApiClient().createUser(dto);
    ctx.latestResponse = response;
  });
};
