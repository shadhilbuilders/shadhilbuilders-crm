// NestJS bootstrap.
// - /api/docs        → Swagger UI (OpenAPI 3.0)
// - /api/docs-json   → OpenAPI spec
// - /api/health      → health check (Coolify uptime monitor)
// - /api/*           → feature routes
//
// Eng review A5: POOL_MODE must be 'session' (RLS requirement). Boot-time
// check throws if not.
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { verifyPoolMode } from '@shadhil/database';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Eng review A5: fail fast if POOL_MODE != 'session' (otherwise RLS breaks).
  // Set POOL_MODE=transaction only after a careful migration plan; the boot
  // check is here to prevent silent data leaks.
  await verifyPoolMode();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('Bootstrap');

  // AR-8: allowlist from env, localhost only outside production. Compose sets
  // CORS_ORIGINS in prod; defaults here are dev-only.
  const corsOrigins = (process.env.CORS_ORIGINS ??
    'http://localhost:3000,http://localhost:8081')
    .split(',')
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
    .addTag('realtime', 'SSE streams')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
  });

  const port = Number(process.env.API_PORT ?? 8080);
  await app.listen(port);
  logger.log(`Shadhil CRM API listening on http://localhost:${port}/api`);
  logger.log(`Swagger UI: http://localhost:${port}/api/docs`);
}

void bootstrap();
