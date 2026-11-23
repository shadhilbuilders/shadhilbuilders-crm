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

import {
  UPLOAD_AUTH_TTL_SECONDS,
  type ByteRange,
  type StorageProvider,
  type StoredFile,
  type StoredObjectInfo,
  type StreamedObject,
  type UploadAuth,
  type UploadAuthRequest,
} from './storage.provider';
import { looksLikeJpeg, looksLikePng } from './sniff-mime';

/** End-to-end response headers worth forwarding; nothing else leaks upstream. */
const FORWARDED_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
] as const;

function pickHeaders(from: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = from.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** Strip path separators / traversal tokens from a filename so a
 *  user-supplied name cannot escape the folder root. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

@Injectable()
export class ImageKitStorage implements StorageProvider {
  private readonly logger = new Logger(ImageKitStorage.name);
  private readonly imagekit: ImageKit;
  private readonly publicKey: string;
  private readonly urlEndpoint: string;

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
    this.publicKey = pub;
    this.urlEndpoint = endpoint;
    this.imagekit = new ImageKit({ publicKey: pub, privateKey: priv, urlEndpoint: endpoint });
  }

  async save(
    data: Buffer,
    meta: { organizationId: string; mimeType: string; filename: string; uploadId?: string },
  ): Promise<StoredFile> {
    const id = meta.uploadId ?? randomBytes(12).toString('hex');
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
      const url = this.signedOriginalUrl(key);
      if (!url) return null;
      // The URL is SIGNED and carries `tr=orig-true` INSIDE the signature
      // (signedOriginalUrl): a private object 403s without `ik-s`, and
      // appending anything to a signed URL also 403s because the signature
      // covers the whole query string. Signing a public object's URL is
      // harmless, so one path serves both.
      //
      // `tr=orig-true` is REQUIRED: a bare CDN URL is delivered through
      // ImageKit's default transformation pipeline, which re-encodes images
      // (verified: a stored 1,080,993-byte PNG came back as a 457,474-byte
      // JPEG). read() must return the ORIGINAL bytes - the outbound Meta /media
      // upload sends these bytes to the customer, so a lossy derivative both
      // misrepresents the file and fails Meta's own type checks.
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`[media] imagekit read failed key=${key} status=${res.status}`);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // BYTES ARE THE TRUTH, THE FILENAME IS A LABEL (2026-11-06).
      //
      // This adapter used to REFUSE to serve bytes whose magic number
      // contradicted the key's extension ("re-encoded JPEG for a PNG key"),
      // on the theory that a mismatch proved ?tr=orig-true was being ignored.
      // That theory is wrong, and the guard broke real uploads: phones
      // routinely produce JPEG bytes under a name the camera roll gave the
      // file (IMG_2676.PNG holding a 27,711-byte JPEG). Verified against the
      // live CDN for exactly that key - `?tr=orig-true` returned 27,711 bytes
      // (ImageKit's own recorded size, mime=image/jpeg) while the BARE url
      // returned a 16,473-byte derivative, so the parameter IS honoured and
      // the stored original really is a JPEG misnamed .PNG.
      //
      // The original-bytes guarantee is instead held by media.controller,
      // which now sniffs the bytes and serves the type they actually are. A
      // mismatch here is logged (it is a useful "someone's filename lies"
      // signal) and never blocks the read.
      const ext = key.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'png' && !looksLikePng(buf) && looksLikeJpeg(buf)) {
        this.logger.debug(
          `[media] key=${key} is named .png but holds JPEG bytes - serving the bytes; ` +
            'the filename came from the device, not from the content',
        );
      }
      return buf;
    } catch (err) {
      this.logger.warn(
        `[media] imagekit read error key=${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    // ImageKit's delete API keys on fileId, not filePath. Look the file up
    // by path first (list API, prefix search); a missing file is fine
    // (nothing to compensate). This is a best-effort compensation path -
    // every failure logs WARN and resolves; the upload request that brought
    // us here has ALREADY failed, so a delete error must never surface to
    // the caller.
    try {
      // listFiles searches a FOLDER (path), so split the key
      // /<org>/<cuid>/<name> into its parent folder + name and filter the
      // result by exact filePath (path search is a prefix, not exact).
      const segments = key.split('/').filter(Boolean);
      const name = segments.pop();
      const folder = '/' + segments.join('/');
      if (!name) return;
      const files = await this.imagekit.listFiles({
        path: folder,
        name,
        limit: 10,
      });
      // Narrow to FileObject (FolderObject carries no fileId): the only
      // fileId-bearing entries are files, and the exact filePath must match.
      // The SDK resolves an IKResponse envelope ({ response: FileObject[] }).
      const list: unknown[] = Array.isArray(files)
        ? files
        : Array.isArray((files as { response?: unknown[] }).response)
          ? (files as { response: unknown[] }).response
          : [];
      const match = list.find(
        (f) =>
          (f as { type?: string }).type === 'file' && (f as { filePath?: string }).filePath === key,
      ) as { fileId?: string } | undefined;
      if (!match) return; // nothing stored under this key (or already gone)
      const fileId = match.fileId;
      if (typeof fileId !== 'string' || fileId.length === 0) return;
      await this.imagekit.deleteFile(fileId);
    } catch (err) {
      this.logger.warn(
        `[media] imagekit delete failed key=${key}: ${err instanceof Error ? err.message : String(err)} - blob orphaned`,
      );
    }
  }

  /**
   * A signed, short-lived URL for the ORIGINAL bytes of `key`.
   *
   * The transformation is part of what gets signed. Measured 2026-11-23 on a
   * 14,268,660 byte private upload: the plain signed URL served 6,159,488
   * bytes (ImageKit re-encodes video unless told not to), and appending
   * `?tr=orig-true` to that signed URL returned 403. So the URL is built once,
   * here, and never touched afterwards. It never leaves the provider.
   */
  private signedOriginalUrl(key: string): string | null {
    if (!key) return null;
    const path = key.startsWith('/') ? key : `/${key}`;
    return this.imagekit.url({
      path,
      signed: true,
      expireSeconds: UPLOAD_AUTH_TTL_SECONDS,
      transformation: [{ raw: 'orig-true' }],
    });
  }

  /** Exact-path lookup through the list API (the same trick `delete` uses). */
  private async findFile(
    key: string,
  ): Promise<{ size?: number; mime?: string; isPrivateFile?: boolean } | null> {
    const segments = key.split('/').filter(Boolean);
    const name = segments.pop();
    if (!name) return null;
    const files = await this.imagekit.listFiles({
      path: '/' + segments.join('/'),
      name,
      limit: 10,
    });
    const list: unknown[] = Array.isArray(files)
      ? files
      : Array.isArray((files as { response?: unknown[] }).response)
        ? (files as { response: unknown[] }).response
        : [];
    const wanted = key.startsWith('/') ? key : `/${key}`;
    const match = list.find(
      (f) =>
        (f as { type?: string }).type === 'file' &&
        (f as { filePath?: string }).filePath === wanted,
    );
    return (match as { size?: number; mime?: string; isPrivateFile?: boolean } | undefined) ?? null;
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    // No try/catch on purpose: an SDK failure must reach the caller as a throw,
    // not as `null`, which would read as "the object does not exist".
    const file = await this.findFile(key);
    if (!file || typeof file.size !== 'number') return null;
    return {
      size: file.size,
      mimeType: file.mime ?? 'application/octet-stream',
      // Absent means "not marked private". Never assume private on a gap:
      // the record route refuses a public clip, so the safe default is public.
      isPrivate: file.isPrivateFile === true,
    };
  }

  async readStream(key: string, range?: ByteRange): Promise<StreamedObject | null> {
    const url = this.signedOriginalUrl(key);
    if (!url) return null;
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end ?? ''}`;
    // redirect: 'follow' is fetch's default and is kept on purpose: any
    // Location is consumed here, so a signed URL never reaches the browser.
    // A network failure rejects out of this method: "could not ask" is not
    // "does not exist".
    const res = await fetch(url, { headers });
    if (res.status === 416) {
      await res.body?.cancel();
      return { status: 416, headers: pickHeaders(res.headers), body: null };
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      this.logger.warn(`[media] imagekit stream failed key=${key} status=${res.status}`);
      throw new Error(`imagekit stream failed for ${key}: status ${res.status}`);
    }
    // A 200 to a ranged request means upstream ignored the range; report the
    // truth rather than relabelling it as 206.
    return {
      status: res.status === 206 ? 206 : 200,
      headers: pickHeaders(res.headers),
      body: res.body as ReadableStream<Uint8Array>,
    };
  }

  async deleteUploadFolder(organizationId: string, uploadId: string): Promise<void> {
    const folder = `/${organizationId}/${uploadId}`;
    try {
      const files = await this.imagekit.listFiles({ path: folder, limit: 100 });
      const list: unknown[] = Array.isArray(files)
        ? files
        : Array.isArray((files as { response?: unknown[] }).response)
          ? (files as { response: unknown[] }).response
          : [];
      for (const f of list) {
        const entry = f as { type?: string; fileId?: string; filePath?: string };
        // Exact-prefix guard: listFiles on a folder returns that folder only,
        // but never trust a listing to stay inside the path it was asked for.
        if (
          entry.type === 'file' &&
          typeof entry.fileId === 'string' &&
          entry.filePath?.startsWith(`${folder}/`) === true
        ) {
          await this.imagekit.deleteFile(entry.fileId);
        }
      }
    } catch (err) {
      this.logger.warn(
        `[media] imagekit folder delete failed ${folder}: ${err instanceof Error ? err.message : String(err)} - blobs orphaned`,
      );
    }
  }

  createUploadAuth(req: UploadAuthRequest): UploadAuth {
    const expire = Math.floor(Date.now() / 1000) + UPLOAD_AUTH_TTL_SECONDS;
    const { token, signature } = this.imagekit.getAuthenticationParameters(undefined, expire);
    return {
      transport: 'direct',
      publicKey: this.publicKey,
      urlEndpoint: this.urlEndpoint,
      token,
      expire,
      signature,
      folder: `/${req.organizationId}/${req.uploadId}/`,
      maxBytes: req.maxBytes,
      isPrivateFile: true,
    };
  }

  publicUrl(key: string): string | null {
    if (!key) return null;
    // key is an imagekit filePath and normally begins with '/'. Prepend the
    // URL endpoint (trimmed of trailing slash) to build the absolute CDN URL.
    //
    // THE LEADING SLASH IS LOAD-BEARING (2026-11-06). A bare `endpoint + key`
    // silently glues them together for a key that lacks it -
    // `https://ik.imagekit.io/paalstack` + `ceid01.../dot.png` becomes
    // `https://ik.imagekit.io/paalstackceid01.../dot.png` - which 404s with no
    // hint why. Upload always returns a slash-prefixed filePath, but rows
    // written by the LOCAL-DISK adapter carry a slashless key
    // (`<org>/<cuid>/<name>`), and those same rows are read through THIS
    // adapter after a MEDIA_STORAGE switch. Normalising here means the URL is
    // correct for both shapes instead of depending on which provider wrote it.
    const endpoint = (process.env.IMAGEKIT_URL_ENDPOINT ?? '').replace(/\/+$/, '');
    if (!endpoint) return null;
    return endpoint + (key.startsWith('/') ? key : `/${key}`);
  }
}
