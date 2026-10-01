import { expect } from 'bun:test';
import { defineFeature, loadFeature } from 'jest-cucumber';
import type { UserResponseDto } from '@tests/test-utils/ApiClient';
import { TestContext } from '@tests/test-utils/TestContext';
import { IdResponse } from '@starter/nest-support/http';
import {
  type CreateUserTestContext,
  givenUserProfileData,
  iSendARequestToCreateAUser,
} from '../user-shared-steps';
import { ApiClient } from '@tests/test-utils/ApiClient';
import { iReceiveAnErrorWithStatusCode } from '@tests/shared/shared-steps';

const feature = loadFeature('tests/user/create-user/create-user.feature');

/**
 * e2e test implementing a Gherkin feature file
 * https://github.com/Sairyss/backend-best-practices#testing
 */

defineFeature(feature, (test) => {
  const apiClient = new ApiClient();

  test('I can create a user', ({ given, when, then, and }) => {
    const ctx = new TestContext<CreateUserTestContext>();

    givenUserProfileData(given, ctx);

    iSendARequestToCreateAUser(when, ctx);

    then('I receive my user ID', () => {
      const response = ctx.latestResponse as IdResponse;
      expect(typeof response.id).toBe('string');
    });

    and('I can see my user in a list of all users', async () => {
      const res = await apiClient.findAllUsers();
      const response = ctx.latestResponse as IdResponse;

      expect(
        res.data.some((item: UserResponseDto) => item.id === response.id),
      ).toBe(true);
    });
  });

  test('I try to create a user with invalid data', ({ given, when, then }) => {
    const ctx = new TestContext<CreateUserTestContext>();

    givenUserProfileData(given, ctx);

    iSendARequestToCreateAUser(when, ctx);

    iReceiveAnErrorWithStatusCode(then, ctx);
  });
});
