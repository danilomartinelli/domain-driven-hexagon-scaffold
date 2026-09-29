import { expect } from 'bun:test';
export const snapshotBaseProps = {
  id: expect.any(String),
  createdAt: expect.any(String),
  updatedAt: expect.any(String),
};
