import { expect } from 'bun:test';
export const snapshotBaseProps = {
  id: expect.any(String) as unknown,
  createdAt: expect.any(String) as unknown,
  updatedAt: expect.any(String) as unknown,
};
