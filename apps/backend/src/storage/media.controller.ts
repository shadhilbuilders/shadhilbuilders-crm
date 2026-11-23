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
// logged-in session. Upload writes into the CALLER's org namespace; read
// refuses any key whose first path segment is not the caller's org
// (media-key-scope.ts). The key namespace is the tenant wall, because the
// stored bytes carry no RLS of their own.
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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Response } from 'express';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { MediaAccessService } from './media-access.service';
import { parseRangeHeader, resolveSuffix } from './parse-range';
import { MAX_UPLOAD_BYTES } from './storage.limits';
import { sniffMime, reconcileUploadMime } from './sniff-mime';
import { STORAGE_PROVIDER } from './storage.tokens';
import type { StorageProvider } from './storage.provider';

// Upload cap moved to the shared storage.limits.ts module (issue #7 slice 1:
// the customer-progress module needs the same cap; one definition, two
// consumers).

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
    @Inject(MediaAccessService) private readonly mediaAccess: MediaAccessService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Upload a chat attachment (image/doc/video/audio). Returns a storage key.',
  })
  async upload(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ key: string; mimeType: string; filename: string; size: number }> {
    const parsed = UploadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('Invalid upload payload');
    }
    const { filename, base64 } = parsed.data;
    // The declared type is only checked against the broad prefix allowlist
    // below; the STORED type comes from the bytes (see reconcileUploadMime).
    const declaredMimeType = parsed.data.mimeType;

    if (!ALLOWED_MIME_PREFIXES.some((p) => declaredMimeType.startsWith(p))) {
      throw new BadRequestException(`Unsupported media type: ${declaredMimeType}`);
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

    // Same rule as the progress-photo upload: record what the BYTES are, not
    // what the filename implied. Falls back to the client's declaration when
    // the format is one we cannot identify (office documents, archives) - the
    // controller-wide prefix allowlist already vetted it.
    const mimeType = reconcileUploadMime(buf, declaredMimeType)?.mimeType ?? declaredMimeType;

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
    @Req() req: AuthedRequest,
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
    // TENANT + ROW WALL (2026-11-07). Two checks, in this order:
    //   1. the key's org segment must be the caller's org (cheap, no query);
    //   2. an owning row must be VISIBLE under the caller's RLS context.
    // Row RLS protects the row; these protect the BYTES it points at. Without
    // (2) a session could read a photo hidden from them just by holding the
    // key. 404 either way - a 403 would confirm the key exists.
    await this.mediaAccess.assertReadable(req.user!, decoded);
    // Video clips stream with byte ranges so a <video> can seek; everything else
    // keeps the buffered path below (its Content-Type comes from the bytes).
    if (decoded.toLowerCase().endsWith('.mp4')) {
      await this.streamVideo(req, res, decoded);
      return;
    }
    const data = await this.storage.read(decoded);
    if (data === null) throw new NotFoundException('Media not found');
    // Write the raw bytes directly to the response (no StreamableFile envelope,
    // no JSON serialization) so <img>/<a> load the exact file bytes.
    //
    // CONTENT-TYPE COMES FROM THE BYTES, NOT THE FILENAME (2026-11-06). The
    // key's extension is user-supplied and frequently lies: a phone's camera
    // roll names a JPEG `IMG_2676.PNG`, and serving that as `image/png` makes
    // the browser drop it outright under `X-Content-Type-Options: nosniff`
    // (set in apps/web/next.config.ts) - the image renders as nothing. Sniff
    // the magic number first and only fall back to the extension for formats
    // we cannot identify (documents, archives).
    res.setHeader('Content-Type', sniffMime(data) ?? guessMime(decoded));
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(data);
  }

  /** Stream a clip: honours a single `Range`, answers 206/416, ends if the client leaves. */
  private async streamVideo(req: AuthedRequest, res: Response, key: string): Promise<void> {
    const parsed = parseRangeHeader(req.headers.range);
    let range;
    if (parsed.kind === 'range') range = parsed.range;
    if (parsed.kind === 'suffix') {
      const info = await this.storage.stat(key);
      if (info === null) throw new NotFoundException('Media not found');
      range = resolveSuffix(parsed.length, info.size);
    }
    const object = await this.storage.readStream(key, range);
    if (object === null) throw new NotFoundException('Media not found');

    res.status(object.status);
    for (const [name, value] of Object.entries(object.headers)) res.setHeader(name, value);
    // Stored clips are verified MP4 at record time; the provider's type is advisory.
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (object.body === null) {
      res.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(object.body as never), res);
    } catch {
      // A seek or a closed tab destroys the response mid-stream: not an error.
      res.destroy();
    }
  }
}

/** Infer a coarse Content-Type from the key's filename for the GET serve. */
function guessMime(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'mp4':
      return 'video/mp4';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}
