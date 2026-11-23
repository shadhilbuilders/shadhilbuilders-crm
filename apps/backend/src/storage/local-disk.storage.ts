// Local-disk StorageProvider - the dev/test implementation of the
// storage abstraction. Prod swaps this for an imagekit.io adapter behind
// the same interface (see storage.provider.ts header).
//
// Layout: <MEDIA_DIR>/<organizationId>/<cuid>/<sanitized-filename>
// The org is part of the key so cross-tenant reads are blocked by the
// key namespace, and the per-file cuid keeps the URL unpredictable.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';

import type {
  ByteRange,
  StorageProvider,
  StoredFile,
  StoredObjectInfo,
  StreamedObject,
  UploadAuth,
  UploadAuthRequest,
} from './storage.provider';

/** Local disk keeps no mime column; the extension is the only hint it has. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function mimeForKey(key: string): string {
  return MIME_BY_EXTENSION[extname(key).toLowerCase()] ?? 'application/octet-stream';
}

/** Strip path separators / traversal tokens from a filename so a
 *  user-supplied name cannot escape the storage root. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

@Injectable()
export class LocalDiskStorage implements StorageProvider {
  /** Absolute, normalised root - the containment check compares against it. */
  private readonly root: string;
  /** Memoised realpath of the root (symlinks resolved), lazily computed. */
  private realRootCache: string | null = null;

  constructor(private readonly mediaDir: string = process.env.MEDIA_DIR ?? 'media') {
    // Resolved ONCE at construction so the containment test never depends on
    // the process cwd changing mid-flight, and so a relative MEDIA_DIR (the
    // documented default, `./media`) is anchored where the app started.
    this.root = resolve(this.mediaDir);
  }

  private rootFor(organizationId: string): string {
    return join(this.root, organizationId);
  }

  /**
   * The media root with symlinks resolved. Falls back to the lexical root when
   * the directory does not exist yet (a fresh install has no root until the
   * first save), because there is then no symlink to follow.
   */
  private realRoot(): string {
    if (this.realRootCache !== null) return this.realRootCache;
    try {
      this.realRootCache = realpathSync(this.root);
    } catch {
      this.realRootCache = this.root;
    }
    return this.realRootCache;
  }

  private isInsideRealRoot(candidate: string, realRoot: string): boolean {
    return candidate === realRoot || candidate.startsWith(realRoot + sep);
  }

  /**
   * The target path with symlinks resolved, or null when it cannot be resolved.
   *
   * When the target itself does not exist, containment is decided by its
   * PARENT: that is the component a planted symlink would redirect, and
   * "missing file" is a normal answer the callers already handle.
   */
  private async realTarget(target: string): Promise<string | null> {
    try {
      return await realpath(target);
    } catch {
      try {
        const parent = await realpath(dirname(target));
        return join(parent, basename(target));
      } catch {
        return null;
      }
    }
  }

  /**
   * Resolve a storage key to an absolute path, or null when it would land
   * outside the media root.
   *
   * THE SEPARATOR IS LOAD-BEARING (2026-11-06). The previous guard was
   * `target.startsWith(join(this.mediaDir))`, which is a bare PREFIX test:
   * a root of `/srv/media` accepts `/srv/media-evil/secret.txt` because that
   * string starts with `/srv/media`. Combined with `join()` normalising `..`,
   * a key of `../media-evil/secret.txt` resolved to exactly that path - so
   * `read()` served files from a sibling directory and `delete()` removed
   * them. Verified by exploit: both read and delete escaped the root.
   *
   * Requiring `root + sep` closes the sibling-prefix hole; the exact-equality
   * arm keeps the root itself addressable (it is a directory, and the callers
   * reject non-files anyway). `..` is also rejected outright rather than
   * relied on to normalise into an escape.
   */
  private keyPath(key: string): string | null {
    // A key is always relative to the root; an absolute one would make
    // `resolve` ignore the root entirely.
    if (key.length === 0 || key.startsWith('/') || key.startsWith('\\')) return null;
    // Reject traversal segments up front (also rejects Windows-style `..\`).
    if (key.split(/[\\/]/).some((segment) => segment === '..')) return null;

    const target = resolve(this.root, key);
    if (target !== this.root && !target.startsWith(this.root + sep)) return null;
    return target;
  }

  /**
   * Lexical containment PLUS symlink containment.
   *
   * A lexical-only check cannot see a symlink planted inside the root
   * (`<root>/org/cuid -> /etc`), which would pass every string test and then
   * let `read()` serve `/etc/passwd` and `delete()` unlink outside the root.
   * This resolves the real path and re-checks it against the real root.
   *
   * `read()` and `delete()` are async, so the extra `realpath` round-trip
   * costs one syscall on a path that was about to be touched anyway.
   */
  private async containedPath(key: string): Promise<string | null> {
    const target = this.keyPath(key);
    if (target === null) return null;
    const resolved = await this.realTarget(target);
    if (resolved === null) return null;
    if (!this.isInsideRealRoot(resolved, this.realRoot())) return null;
    return target;
  }

  async save(
    data: Buffer,
    meta: { organizationId: string; mimeType: string; filename: string },
  ): Promise<StoredFile> {
    const id = randomBytes(12).toString('hex');
    const safeName = sanitizeFilename(meta.filename || `file`);
    const key = `${meta.organizationId}/${id}/${safeName}`;
    // save() builds the key itself, so a null here would be a bug in THIS
    // method (e.g. an org id containing '..'), not attacker input.
    const target = this.keyPath(key);
    if (target === null) {
      throw new Error(`Refusing to write outside the media root: ${key}`);
    }
    const dir = join(this.rootFor(meta.organizationId), id);
    await mkdir(dir, { recursive: true });
    // A symlink at the target DIRECTORY would survive mkdir (EEXIST is
    // swallowed by `recursive`) and make writeFile follow it out of the root.
    // Verify the directory we are about to write into resolves inside it.
    const realDir = await this.realTarget(dir);
    if (realDir === null || !this.isInsideRealRoot(realDir, this.realRoot())) {
      throw new Error(`Refusing to write through a symlink outside the media root: ${key}`);
    }
    await writeFile(target, data);
    return { key, mimeType: meta.mimeType, filename: safeName, size: data.length };
  }

  async read(key: string): Promise<Buffer | null> {
    const target = await this.containedPath(key);
    if (target === null) return null;
    if (!existsSync(target)) return null;
    const st = await stat(target);
    if (!st.isFile()) return null;
    return readFile(target);
  }

  async delete(key: string): Promise<void> {
    // Same containment rule as read(): a key that escapes the root is NOT a
    // missing file to shrug at - it is a refused operation. `rm` below still
    // resolves for a genuinely absent path (force: true).
    const target = await this.containedPath(key);
    if (target === null) return;
    await rm(target, { force: true, recursive: true });
  }

  publicUrl(key: string): string | null {
    // Local disk has no public base; served via the proxied GET /api/media.
    return null;
  }

  /**
   * Local disk has no CDN, so the bytes travel through the API: the client
   * takes the `inline` branch with the same ceiling the server enforces.
   */
  createUploadAuth(req: UploadAuthRequest): UploadAuth {
    return { transport: 'inline', maxBytes: req.maxBytes };
  }

  async stat(key: string): Promise<StoredObjectInfo | null> {
    const target = await this.containedPath(key);
    if (target === null) return null;
    try {
      const st = await stat(target);
      if (!st.isFile()) return null;
      // Nothing on local disk is reachable except through the authenticated
      // media route, so every object is private in the sense that matters.
      return { size: st.size, mimeType: mimeForKey(key), isPrivate: true };
    } catch {
      return null;
    }
  }

  async readStream(key: string, range?: ByteRange): Promise<StreamedObject | null> {
    const target = await this.containedPath(key);
    if (target === null) return null;
    let size: number;
    try {
      const st = await stat(target);
      if (!st.isFile()) return null;
      size = st.size;
    } catch {
      return null;
    }

    const baseHeaders = { 'accept-ranges': 'bytes', 'content-type': mimeForKey(key) };
    if (range === undefined) {
      return {
        status: 200,
        headers: { ...baseHeaders, 'content-length': String(size) },
        body: size === 0 ? emptyBody() : toWebStream(createReadStream(target)),
      };
    }

    const start = range.start;
    const end = Math.min(range.end ?? size - 1, size - 1);
    if (!Number.isInteger(start) || start < 0 || start >= size || end < start) {
      return {
        status: 416,
        headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
        body: null,
      };
    }
    return {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
      },
      body: toWebStream(createReadStream(target, { start, end })),
    };
  }
}

function toWebStream(node: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (c) => c.close() });
}
