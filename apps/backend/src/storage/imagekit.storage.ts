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
// - `read()` fetches the original bytes from ImageKit's URL (untransformed)
//   so we never hand a transformed derivative to Meta's /media upload.
// - Images are public by default (CDN-served, no signed URL needed for the
//   chat pane). `publicUrl()` returns the plain CDN URL; consumers that want
//   transformation-ready URLs can call imagekit.url() directly.
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
      // No transformation string → serves the original bytes.
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`[media] imagekit read failed key=${key} status=${res.status}`);
        return null;
      }
      return Buffer.from(await res.arrayBuffer());
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
