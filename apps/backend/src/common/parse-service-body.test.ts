// parseServiceBody - the service-layer counterpart to the controllers'
// `parseBody`.
//
// THE BUG THIS PINS (2026-11-19): services that re-parse a payload the client
// never sent directly (public form → internal create DTO, WhatsApp contact →
// Lead) used `Schema.parse()`. That throws a raw `ZodError`, which the global
// exception filter does not recognise, so it fell through to
//
//     500 INTERNAL_ERROR "Something went wrong on our end."
//
// for a merely invalid phone number - on an UNAUTHENTICATED public endpoint,
// logged with a stack trace as if the server had broken. Client input errors
// must be 400s with a per-field message.
import { BadRequestException } from '@nestjs/common';
import { CreateLeadDtoSchema } from '@shadhil/api-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseServiceBody } from './parse-service-body';

describe('parseServiceBody', () => {
  it('returns the parsed value on success', () => {
    const parsed = parseServiceBody(z.object({ name: z.string() }), { name: 'Asha' });
    expect(parsed).toEqual({ name: 'Asha' });
  });

  it('throws BadRequestException (400), NOT a raw ZodError', () => {
    // A raw ZodError is what produced the 500 - assert the class explicitly.
    expect(() => parseServiceBody(z.object({ n: z.number() }), { n: 'x' })).toThrow(
      BadRequestException,
    );
  });

  it('carries status 400 so the exception filter answers 400', () => {
    try {
      parseServiceBody(z.object({ n: z.number() }), { n: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getStatus()).toBe(400);
    }
  });

  it('names the offending field so the UI can place the message', () => {
    try {
      parseServiceBody(z.object({ phone: z.string().min(10) }), { phone: '123' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { message: string[] | string };
      const text = Array.isArray(body.message) ? body.message.join(' ') : body.message;
      expect(text).toContain('phone');
    }
  });

  it('falls back to the `what` label when the issue has no path', () => {
    try {
      parseServiceBody(z.string(), 42, 'lead');
      expect.unreachable('should have thrown');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { message: string[] | string };
      const text = Array.isArray(body.message) ? body.message.join(' ') : body.message;
      expect(text).toContain('lead');
    }
  });

  // The real-world case: the public landing form's phone reaches the internal
  // create DTO. A garbage number must be a 400 naming `phone`.
  it('rejects a garbage phone on the real lead schema with a 400', () => {
    expect(() =>
      parseServiceBody(
        CreateLeadDtoSchema,
        {
          name: 'Asha',
          phone: 'abcdefg123',
          source: 'WALK_IN',
          projectId: 'oe6g1xkagiisnn4oeefpdyhk',
          teamId: undefined,
        },
        'lead',
      ),
    ).toThrow(BadRequestException);
  });

  it('accepts a valid Indian mobile on the real lead schema', () => {
    // Sanity: the guard above must not reject legitimate input.
    const parsed = parseServiceBody(
      CreateLeadDtoSchema,
      {
        name: 'Asha',
        phone: '9876543210',
        source: 'WALK_IN',
        projectId: 'oe6g1xkagiisnn4oeefpdyhk',
        teamId: undefined,
      },
      'lead',
    );
    // PhoneSchema normalizes on the way through - proves we used the REAL
    // schema, not a stub.
    expect(parsed.phone).toBe('919876543210');
  });
});
