// Local-disk StorageProvider - the dev/test implementation of the
// storage abstraction. Prod swaps this for an imagekit.io adapter behind
// the same interface (see storage.provider.ts header).
//
// Layout: <MEDIA_DIR>/<organizationId>/<cuid>/<sanitized-filename>
// The org is part of the key so cross-tenant reads are blocked by the
// key namespace, and the per-file cuid keeps the URL unpredictable.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import type { StorageProvider, StoredFile } from './storage.provider';

/** Strip path separators / traversal tokens from a filename so a
 *  user-supplied name cannot escape the storage root. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

@Injectable()
export class LocalDiskStorage implements StorageProvider {
  constructor(private readonly mediaDir: string = process.env.MEDIA_DIR ?? 'media') {}

  private rootFor(organizationId: string): string {
    return join(this.mediaDir, organizationId);
  }

  private keyPath(key: string): string {
    // Key shape: org/cuid/filename. join() keeps it inside mediaDir.
    return join(this.mediaDir, key);
  }

  async save(
    data: Buffer,
    meta: { organizationId: string; mimeType: string; filename: string },
  ): Promise<StoredFile> {
    const id = randomBytes(12).toString('hex');
    const safeName = sanitizeFilename(meta.filename || `file`);
    const key = `${meta.organizationId}/${id}/${safeName}`;
    const dir = join(this.rootFor(meta.organizationId), id);
    await mkdir(dir, { recursive: true });
    const target = this.keyPath(key);
    await writeFile(target, data);
    return { key, mimeType: meta.mimeType, filename: safeName, size: data.length };
  }

  async read(key: string): Promise<Buffer | null> {
    // Guard against traversal - resolve and confirm we stay inside mediaDir.
    const target = this.keyPath(key);
    if (!target.startsWith(join(this.mediaDir))) return null;
    if (!existsSync(target)) return null;
    const st = await stat(target);
    if (!st.isFile()) return null;
    return readFile(target);
  }

  publicUrl(key: string): string | null {
    // Local disk has no public base; served via the proxied GET /api/media.
    return null;
  }
}
