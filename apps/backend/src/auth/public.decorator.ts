// Public route decorator - bypasses the global JwtAuthGuard.
// Use for: /health, /auth/login, /auth/signup, /webhooks/whatsapp (Meta
// verification), /webhooks/frejun (signature header is its own auth).
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
