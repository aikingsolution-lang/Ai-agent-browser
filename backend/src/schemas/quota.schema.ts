import { z } from 'zod';

/** One job submission, identified by a client key such as "linkedin:3912345678". */
export const applicationSlotSchema = z
  .object({
    jobKey: z.string().trim().min(1, 'jobKey is required').max(512, 'jobKey is too long'),
  })
  .strict();
