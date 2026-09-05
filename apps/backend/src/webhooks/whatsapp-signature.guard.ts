// T-E2b: HMAC-SHA256 signature guard for the WhatsApp inbound webhook.
//
// Meta signs every POST to the configured callback URL with
// `X-Hub-Signature-256: sha256=<hex>`, computed as
// `HMAC-SHA256(META_APP_SECRET, raw_request_body)`. The raw body is
// the EXACT bytes of the HTTP request — re-stringifying
// `JSON.parse(body)` will change whitespace/key-ordering and break
// the verification, which is why main.ts enables
// `NestFactory.create(AppModule, { rawBody: true })` so the
// `req.rawBody` Buffer is available here.
//
// Two-mode behavior (per the T-E2b plan hard-call #1):
//   1. **Dev pass-through (WA_APP_SECRET unset):** log a warning and
//      let the request through. This lets the local dev / smoke-test
//      environment receive webhooks without real Meta creds wired up
//      yet — the user explicitly chose to test against a
//      WHATSAPP_PHONE_NUMBER_ID test number.
//   2. **Prod verification (WA_APP_SECRET set):** compare the
//      signature using `crypto.timingSafeEqual` (NOT `===` — the
//      constant-time compare is the standard defense against timing
//      attacks on HMAC). Mismatch → 401 Unauthorized.
//
// The dev pass-through is the only path that can ever accept
// unauthenticated traffic. In production (NODE_ENV=production), an
// unset WA_APP_SECRET causes the guard to fail closed with 503
// (rather than pass-through silently) so a deploy with a missing
// secret is loud, not silent.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as crypto from 'node:crypto';

import { Public } from '../auth/public.decorator';

export const SKIP_WA_SIGNATURE_CHECK = 'skipWaSignatureCheck';
export const SkipWaSignatureCheck = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_WA_SIGNATURE_CHECK, true);

interface RawBodyRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  method: string;
}

@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappSignatureGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Opt-out: handlers can decorate with @SkipWaSignatureCheck() for
    // test/dev paths. The GET verify-handshake route is also exempt
    // (it has no body to sign).
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_WA_SIGNATURE_CHECK,
      [context.getHandler(), context.getClass()],
    );
    if (skip) return true;

    // The GET verify handshake (challenge-response) is unauthenticated
    // by design — it carries a shared secret in the URL, not a
    // signature. Pass it through; the controller checks the verify
    // token before echoing the challenge.
    const req = context.switchToHttp().getRequest<RawBodyRequest>();
    if (req.method === 'GET') return true;

    const appSecret = process.env['WA_APP_SECRET'];
    if (!appSecret) {
      if (process.env['NODE_ENV'] === 'production') {
        // Fail closed in production — a missing secret must NEVER
        // result in unauthenticated traffic being accepted.
        throw new ServiceUnavailableException(
          'WA_APP_SECRET is not set; refusing to verify webhook signatures in production',
        );
      }
      // Dev pass-through. Log a one-time-per-process warning so a
      // dev knows their webhook is being trusted blindly, but don't
      // spam the log on every request — once per boot is enough.
      this.warnOnce(
        'WA_APP_SECRET is unset; webhook signature verification SKIPPED (dev mode). Set WA_APP_SECRET to verify Meta signatures.',
      );
      return true;
    }

    const signatureHeader = req.headers['x-hub-signature-256'];
    const signature = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    if (!signature) {
      throw new UnauthorizedException(
        'Missing X-Hub-Signature-256 header',
      );
    }

    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      // The raw body is missing — likely the request came in without
      // the JSON parser touching it (e.g. an empty body). Without the
      // raw bytes, HMAC verification is impossible.
      throw new UnauthorizedException(
        'Cannot verify signature: request body was not captured',
      );
    }

    const expected = `sha256=${crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex')}`;

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (
      sigBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expBuf)
    ) {
      this.logger.warn('WhatsApp webhook signature mismatch');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }

  private hasWarned = false;
  private warnOnce(message: string): void {
    if (this.hasWarned) return;
    this.hasWarned = true;
    this.logger.warn(message);
  }
}

// Re-export Public so consumers can import from one place. The
// webhook controller is annotated @Public() (per AR-8: the routes
// receive calls from Meta's servers, not authenticated users) AND
// the WA signature guard, which is a DIFFERENT auth mechanism
// (shared-secret HMAC instead of a session cookie). They are
// complementary, not redundant.
export { Public };
