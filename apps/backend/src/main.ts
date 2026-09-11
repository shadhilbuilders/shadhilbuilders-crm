// NestJS bootstrap.
// - /api/docs        → Swagger UI (OpenAPI 3.0)
// - /api/docs-json   → OpenAPI spec
// - /api/health      → health check (Coolify uptime monitor)
// - /api/*           → feature routes
//
// T-G8 (eng review A2 / 2026-09-03): fail-fast at boot for every required
// env var. The previous behavior (process.env.X ?? 'silent-default') led
// to production running with a localhost Redis URL when the real one was
// missing - silent failure of pub/sub + cron leases. assertBootEnv() runs
// FIRST so the container exits with a clear error instead of starting
// half-dead. The validator lives in ./boot-env.ts and is unit-tested in
// boot-env.test.ts.
//
// Eng review A5: POOL_MODE must be 'session' (RLS requirement). Boot-time
// check throws if not.
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { verifyPoolMode } from '@shadhil/database';
import { AppModule } from './app.module';
import { assertBootEnv } from './boot-env';

async function bootstrap(): Promise<void> {
  // T-G8: fail fast on missing/invalid boot env BEFORE any other init.
  // A misconfigured container exits with the full list of gaps, not a
  // half-initialized Nest app failing on the first Redis call.
  const env = assertBootEnv();

  // Eng review A5: fail fast if POOL_MODE != 'session' (otherwise RLS breaks).
  // Set POOL_MODE=transaction only after a careful migration plan; the boot
  // check is here to prevent silent data leaks. assertBootEnv already
  // validated the value; verifyPoolMode double-checks against the actual
  // PgBouncer config it can introspect.
  await verifyPoolMode();

  // T-E2b: enable raw body capture so the WhatsApp webhook signature
  // guard can HMAC-SHA256 the original POST bytes (Meta signs the exact
  // request body; re-stringifying JSON.parse()'d objects would change
  // whitespace/encoding and break the verification). The buffer is held
  // on `req.rawBody` (Buffer) and consumed only by signature middleware
  // - the JSON body parser still produces `req.body` as normal.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const logger = new Logger('Bootstrap');

  // AR-8: allowlist from env, localhost only outside production. Compose sets
  // CORS_ORIGINS in prod; defaults here are dev-only.
  const corsOrigins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // ── OpenAPI / Swagger ─────────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Shadhil Builders CRM API')
    .setDescription(
      'REST + SSE API for lead management, visits, bookings, chat, reminders, notifications.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'jwt',
    )
    .addTag('auth', 'better-auth catch-all + JWT bridge')
    .addTag('leads', 'Lead CRUD + state machine + reassignment')
    .addTag('visits', 'Site visit scheduling + outcomes')
    .addTag('chat', 'In-app + WhatsApp messaging')
    .addTag('bookings', 'Booking lifecycle + manager approval')
    .addTag('reminders', 'Scheduled reminders + cron processor')
    .addTag('notifications', 'In-app inbox + push delivery')
    .addTag('audit', 'Audit log queries')
    .addTag('webhooks', 'WhatsApp + FreJun inbound')
    .addTag('feedback', 'Public feedback submissions + admin triage')
    .addTag('public', 'Public API-key-gated endpoints (landing page)')
    .addTag('realtime', 'SSE streams')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
  });

  const port = env.API_PORT;
  await app.listen(port);
  logger.log(`Shadhil CRM API listening on http://localhost:${port}/api`);
  logger.log(`Swagger UI: http://localhost:${port}/api/docs`);
}

void bootstrap();
