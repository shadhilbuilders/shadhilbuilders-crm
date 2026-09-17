// Media controller - upload + read chat attachments.
//
// MEDIA (2026-09-17):
//   POST /api/media   - accept { filename, mimeType, base64 } (JSON, because
//                       the BFF proxy reads request.text() and re-posts as
//                       JSON - multipart would be re-serialized and break).
//                       Validates type/size, saves via StorageProvider,
//                       returns { key, mimeType, filename, size }.
//   GET  /api/media/:key - stream the stored file back to the web pane
//                       (proxied through the BFF).
//
// Auth: global JwtAuthGuard (not @Public). Upload and read both require a
// logged-in staff session. The key is org-namespaced by the provider, so a
// cross-tenant key simply doesn't exist.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { STORAGE_PROVIDER } from './storage.tokens';
import type { StorageProvider } from './storage.provider';

// Meta's media caps (document 100MB, image 5MB, video 16MB, audio 16MB).
// We cap at image/audio/video size for the base64 body (docs up to 16MB
// keeps the JSON body manageable through the BFF). ImageKit has no lower cap.
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024; // 16MB

const ALLOWED_MIME_PREFIXES = ['image/', 'application/pdf', 'text/', 'video/', 'audio/'];

const UploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  // base64 data WITHOUT the data: prefix (client strips it). Validated
  // non-empty + size-bounded after decode.
  base64: z.string().min(1),
});

@ApiTags('media')
@ApiBearerAuth('jwt')
@Controller('media')
export class MediaController {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Upload a chat attachment (image/doc/video/audio). Returns a storage key.' })
  async upload(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ key: string; mimeType: string; filename: string; size: number }> {
    const parsed = UploadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Invalid upload payload');
    }
    const { filename, mimeType, base64 } = parsed.data;

    if (!ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) {
      throw new BadRequestException(`Unsupported media type: ${mimeType}`);
    }

    let buf: Buffer;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      throw new BadRequestException('Invalid base64 payload');
    }
    if (buf.length === 0) throw new BadRequestException('Empty file');
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(`File too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB)`);
    }

    const stored = await this.storage.save(buf, {
      organizationId: req.user!.organizationId,
      mimeType,
      filename,
    });
    return {
      key: stored.key,
      mimeType: stored.mimeType,
      filename: stored.filename,
      size: stored.size,
    };
  }

  @Get(':key')
  @ApiOperation({ summary: 'Read a stored chat attachment by key.' })
  async read(
    @Param('key') key: string,
    @Res() res: Response,
  ): Promise<void> {
    // The key may contain slashes (org/id/filename) - the frontend URL-encodes
    // it when building /api/media/:key, so decode here (Nest 12 route is a
    // single :key segment).
    let decoded: string;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      throw new NotFoundException('Media not found');
    }
    const data = await this.storage.read(decoded);
    if (data === null) throw new NotFoundException('Media not found');
    // Write the raw bytes directly to the response (no StreamableFile envelope,
    // no JSON serialization) so <img>/<a> load the exact file bytes.
    res.setHeader('Content-Type', guessMime(decoded));
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(data);
  }
}

/** Infer a coarse Content-Type from the key's filename for the GET serve. */
function guessMime(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    case 'mp4': return 'video/mp4';
    case 'mp3': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}
