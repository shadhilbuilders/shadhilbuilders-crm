// Shared request-body parsing for the SERVICE layer.
//
// WHY THIS EXISTS (2026-11-19). The API contract is a set of shared Zod DTOs
// (`@shadhil/api-types`) that both the NestJS controllers and the Next.js
// client parse with. Controllers parse via their local `parseBody` helper and
// get a clean 400. But three services ALSO re-parse a payload internally -
// because they build a DTO the client never sends (a synthetic actor, a
// server-forced `source`, a public form mapped onto the internal create DTO):
//
//   - public-leads.service.ts        CreateLeadDtoSchema.parse({...})
//   - whatsapp-unknown-contacts       CreateLeadDtoSchema.parse({...})
//   - (any future service)
//
// Those called `.parse()`, which THROWS a raw `ZodError`. Nothing in the
// global exception filter recognised it, so a user typing a bad phone number
// on the PUBLIC landing form received
//
//     500 {"code":"INTERNAL_ERROR","message":"Something went wrong on our end."}
//
// and the server logged it as UNHANDLED with a stack trace - i.e. a client
// input error was recorded as a server bug, on an unauthenticated endpoint.
// That is the opposite of "the backend validates and answers honestly".
//
// `parseServiceBody` gives those sites the same 400 the controllers emit, in
// the same `field: message` shape, so the UI can put the text under the
// offending input regardless of which layer caught it.
//
// NEVER use `.parse()` on request-derived data. If it can come from a client,
// it goes through here (or the controller's parseBody) so the failure is a
// 400, not a 500.
import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Parse an untrusted value with a shared Zod schema, raising a 400 with the
 * same `path: message` formatting the controllers use.
 *
 * @param schema the DTO schema (normally from `@shadhil/api-types`)
 * @param value  the untrusted payload
 * @param what   label for the log/payload, e.g. 'lead' - purely diagnostic
 */
export function parseServiceBody<T>(schema: z.ZodType<T>, value: unknown, what = 'body'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new BadRequestException(
    result.error.issues.map((issue) => {
      const path = issue.path.join('.') || what;
      return `${path}: ${issue.message}`;
    }),
  );
}
