// Env validation — fail fast at module load if required vars are missing.
// Per `better-auth-best-practices` skill: BETTER_AUTH_SECRET min 32 chars.
import { z } from 'zod';

const authEnvSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be >= 32 chars'),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL must be a valid URL'),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export function assertAuthEnv(): AuthEnv {
  const result = authEnvSchema.safeParse({
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid auth env:\n${issues}`);
  }
  return result.data;
}
