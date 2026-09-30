import { z } from 'zod';

export const walletSchema = z.object({
  id: z.string().min(1).max(255),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  balance: z.number().min(0).max(9999999),
  userId: z.string().min(1).max(255),
});
