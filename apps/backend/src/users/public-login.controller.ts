// Public login resolver (2026-11-21) - "email or phone + password" -> the
// address the browser signs in with.
//
// WHY THIS ROUTE EXISTS: better-auth's credential sign-in looks a user up by
// email alone, so a phone number cannot be handed to it. This route proves the
// password itself and answers with the account's email; the client then calls
// the ordinary `signIn.email`, which keeps sessions, cookies, refresh and every
// better-auth hook on the path that already works.
//
// Deliberate properties:
//   * ALWAYS 200 with a discriminated body (`ok` / `pick` / `invalid`). A 401 for
//     a wrong password and a 404 for an unknown account is an enumeration
//     oracle, and this endpoint is unauthenticated.
//   * The response for `pick` carries names and organisations, never emails or
//     phone numbers, and only for accounts whose password already matched.
//   * Rate limited per IP through @nestjs/throttler. better-auth's own limiter
//     covers `/api/auth/*` only, which this is not.
//   * The password is verified off the event loop with a concurrency cap; see
//     `users/login-identifier.ts` for why both matter.
import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  LoginIdentifierDtoSchema,
  type LoginIdentifierDto,
  type LoginIdentifierResult,
} from '@shadhil/api-types';
import { z } from 'zod';

import { Public } from '../auth/public.decorator';
import { CodedBadRequestException } from '../common/errors/coded-exception';

import { UsersService } from './users.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CodedBadRequestException(
      'INVALID_LOGIN_INPUT',
      first?.message ?? 'Enter your email or phone number and password',
    );
  }
  return parsed.data;
}

@ApiTags('public-auth')
@Controller('public/auth')
@UseGuards(ThrottlerGuard)
export class PublicLoginController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Public()
  @Post('login-identifier')
  @HttpCode(200)
  // 10 per minute per IP: a person mistyping a password needs a handful of
  // attempts, and an attacker needs orders of magnitude more than ten.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Resolve an email or phone number plus password into the address to sign in with ' +
      '(no JWT). Always 200: kind "ok" carries the email, "pick" lists the accounts the ' +
      'number is linked to when more than one password matched, "invalid" covers every ' +
      'failure without saying which.',
  })
  async loginIdentifier(@Body() body: unknown): Promise<LoginIdentifierResult> {
    const dto: LoginIdentifierDto = parseBody(LoginIdentifierDtoSchema, body);
    return this.users.resolveLoginIdentifier(dto);
  }
}
