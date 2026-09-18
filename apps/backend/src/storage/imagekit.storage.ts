// imagekit.io StorageProvider - the production backend for chat media
// attachments (decision 1A → imagekit). Drop-in for LocalDiskStorage behind
// the SAME StorageProvider interface (see storage.provider.ts header), so
// no consumer (chat / outbound / webhook / media.controller) changes.
//
// Design notes
// ------------
// - `key` = ImageKit filePath (e.g. `/org-id/<cuid>/<name>`). Using the
//   filePath (not a raw fileId) keeps the key opaque, org-namespaced and
//   reversible through `read()` - exactly like LocalDiskStorage - so the BFF
//   proxy (/api/bff/media/:key) and the outbound Meta send (read bytes back)
//   work unchanged.
// - `read()` appends `?tr=orig-true` and fetches the ORIGINAL bytes from
//   ImageKit. The parameter is load-bearing: a bare CDN URL goes through the
//   default transformation pipeline, which silently re-encodes images (a
//   stored 1MB PNG came back as a 457KB JPEG). The outbound Meta /media upload
//   sends these bytes to the customer, so a lossy derivative is not acceptable.
// - Images are public by default (CDN-served, no signed URL needed for the
//   chat pane). `publicUrl()` returns the plain CDN URL - correct for display
//   (the browser can take the optimised form), NOT for reading bytes; use
//   `read()` for that. Consumers wanting transformation-ready URLs can call
//   imagekit.url() directly.
// - Env: IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, IMAGEKIT_URL_ENDPOINT.
//   Missing/invalid creds throw at construction (fail-fast, no silent empty
//   media) - unlike LocalDiskStorage which needs nothing.
import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import ImageKit from 'imagekit';

import type { StorageProvider, StoredFile } from './storage.provider';

/** Strip path separators / traversal tokens from a filename so a
 *  user-supplied name cannot escape the folder root. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

@Injectable()
export class ImageKitStorage implements StorageProvider {
  private readonly logger = new Logger(ImageKitStorage.name);
  private readonly imagekit: ImageKit;

  constructor() {
    const pub = process.env.IMAGEKIT_PUBLIC_KEY;
    const priv = process.env.IMAGEKIT_PRIVATE_KEY;
    const endpoint = process.env.IMAGEKIT_URL_ENDPOINT;
    if (!pub || !priv || !endpoint) {
      throw new Error(
        'ImageKitStorage requires IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY ' +
          'and IMAGEKIT_URL_ENDPOINT. Set them before using imagekit storage ' +
          '(or use MEDIA_STORAGE=local for LocalDiskStorage).',
      );
    }
    this.imagekit = new ImageKit({ publicKey: pub, privateKey: priv, urlEndpoint: endpoint });
  }

  async save(
    data: Buffer,
    meta: { organizationId: string; mimeType: string; filename: string },
  ): Promise<StoredFile> {
    const id = randomBytes(12).toString('hex');
    const safeName = sanitizeFilename(meta.filename || 'file');
    // folder is org-scoped; fileName gets a unique suffix so re-uploads of
    // the same name never collide with the previous file.
    const upload = await this.imagekit.upload({
      file: data,
      fileName: safeName,
      folder: `/${meta.organizationId}/${id}`,
      useUniqueFileName: true,
    });
    const key = upload.filePath;
    this.logger.debug(`[media] imagekit upload filePath=${key} name=${safeName}`);
    return {
      key,
      mimeType: meta.mimeType,
      filename: safeName,
      size: data.length,
    };
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      const url = this.publicUrl(key);
      if (!url) return null;
      // `?tr=orig-true` is REQUIRED: a bare CDN URL is delivered through
      // ImageKit's default transformation pipeline, which re-encodes images
      // (verified: a stored 1,080,993-byte PNG came back as a 457,474-byte
      // JPEG). read() must return the ORIGINAL bytes - the outbound Meta /media
      // upload sends these bytes to the customer, so a lossy derivative both
      // misrepresents the file and fails Meta's own type checks.
      const res = await fetch(`${url}?tr=orig-true`);
      if (!res.ok) {
        this.logger.warn(`[media] imagekit read failed key=${key} status=${res.status}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Fail loud rather than serving a derivative silently: a JPEG magic
      // number for a key whose stored mime says PNG means the orig-true
      // parameter stopped being honoured.
      const ext = key.split('.').pop()?.toLowerCase() ?? '';
      const looksPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      const looksJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      if (ext === 'png' && !looksPng && looksJpeg) {
        this.logger.error(
          `[media] imagekit read returned a re-encoded JPEG for a PNG key=${key} - ` +
            'the ?tr=orig-true parameter is not being honoured; refusing to serve a derivative',
        );
        return null;
      }
      return buf;
    } catch (err) {
      this.logger.warn(`[media] imagekit read error key=${key}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  publicUrl(key: string): string | null {
    if (!key) return null;
    // key is an imagekit filePath already (begins with /). Prepend the URL
    // endpoint (trimmed of trailing slash) to build the absolute CDN URL.
    const endpoint = (process.env.IMAGEKIT_URL_ENDPOINT ?? '').replace(/\/+$/, '');
    if (!endpoint) return null;
    return endpoint + key;
  }
}
