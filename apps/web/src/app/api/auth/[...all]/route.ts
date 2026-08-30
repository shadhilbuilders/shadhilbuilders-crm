// better-auth catch-all route — handles /api/auth/* requests.
// Per `better-auth-best-practices` skill.
import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth.handler);
