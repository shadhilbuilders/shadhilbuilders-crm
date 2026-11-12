// The client-side MIME coercion must be GONE (2026-11-08, Slice 15).
//
// `normalizeMimeType` relabelled whatever the browser declared as image/jpeg
// while the server sniffed the BYTES and refused HEIC - so the relabel cost a
// round trip and fixed nothing. The conversion in `photo-prep.ts` replaced it.
//
// protects= no module relabels a photo's declared type on the way to the upload;
// fails_when= the old helper (or an equivalent re-stamp of `mimeType`) comes
//           back and silently sends HEIC bytes as JPEG again;
// no_claim= this is a source-shape check, not a behavioural one: the behaviour is
//           pinned by photo-prep.test.ts and the upload schema tests.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** Every .ts/.tsx file under src, skipping tests and node_modules. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    if (entry.includes('.test.') || entry.includes('.spec.')) continue;
    out.push(full);
  }
  return out;
}

/** Strip line comments so prose ABOUT the removed helper is not flagged. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const comment = line.indexOf('//');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');
}

describe('photo type coercion', () => {
  it('has no normalizeMimeType left anywhere in the app', () => {
    const offenders = sourceFiles(SRC).filter((file) =>
      codeOnly(readFileSync(file, 'utf8')).includes('normalizeMimeType'),
    );
    expect(offenders).toEqual([]);
  });

  it('does not hand-stamp image/jpeg over a declared type', () => {
    // The specific lie the old helper told. `photo-prep.ts` may NAME the type it
    // got back; nothing may FORCE one onto a file the browser described.
    const offenders = sourceFiles(SRC).filter((file) => {
      const text = codeOnly(readFileSync(file, 'utf8'));
      return (
        /mimeType:\s*'image\/jpeg'\s*\?\?/.test(text) ||
        /:\s*'image\/jpeg';?\s*\/\/ fallback/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });
});
