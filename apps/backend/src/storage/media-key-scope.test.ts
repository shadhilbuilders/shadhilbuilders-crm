// media-key-scope - the tenant boundary for GET /api/media/:key.
//
// protects= a stored key is servable ONLY to the org whose id is its first
//           path segment, for both provider key shapes (LocalDisk writes
//           `{org}/{id}/{name}`, ImageKit returns `/{org}/{id}/{name}`).
// fails_when= a cross-org key returns true, a key with no org segment is
//           waved through, or a traversal/encoded-separator key parses.
// no_claim= this is NOT row-level authorization. It proves the bytes belong to
//           the caller's ORG, not that the caller may see this particular
//           photo/attachment. RLS still owns "which rows", and a staff member
//           in the right org can read any key they hold, by design.
import { describe, expect, it } from 'vitest';

import { keyBelongsToOrg, keyInUploadFolder, orgOfKey } from './media-key-scope';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const OTHER = 'cyid01lpfe1esm8jwsxid41k29';

describe('keyBelongsToOrg', () => {
  it('accepts the LocalDisk shape ({org}/{id}/{name})', () => {
    expect(keyBelongsToOrg(`${ORG}/abc123/site.jpg`, ORG)).toBe(true);
  });

  it('accepts the ImageKit shape (leading slash on the same key)', () => {
    expect(keyBelongsToOrg(`/${ORG}/abc123/site.jpg`, ORG)).toBe(true);
  });

  it('rejects another org key in either shape', () => {
    expect(keyBelongsToOrg(`${OTHER}/abc123/site.jpg`, ORG)).toBe(false);
    expect(keyBelongsToOrg(`/${OTHER}/abc123/site.jpg`, ORG)).toBe(false);
  });

  // The actual bug: the org was in the key but never compared.
  it('fails_when= a cross-org key would be served (the regression this pins)', () => {
    const victimKey = `${OTHER}/deadbeef/progress-photo.jpg`;
    expect(keyBelongsToOrg(victimKey, ORG)).toBe(false);
  });

  it('rejects an org id that is merely a PREFIX of the real one', () => {
    // 'ceid01' must not pass for 'ceid01lpfe...' - comparison is on the whole
    // first segment, not a startsWith.
    expect(keyBelongsToOrg(`${ORG}/abc/x.jpg`, ORG.slice(0, 6))).toBe(false);
  });

  it('rejects a key with no org segment at all', () => {
    expect(keyBelongsToOrg('site.jpg', ORG)).toBe(false);
    expect(keyBelongsToOrg('/site.jpg', ORG)).toBe(false);
  });

  it('rejects empty, whitespace-only and non-string input', () => {
    expect(keyBelongsToOrg('', ORG)).toBe(false);
    expect(keyBelongsToOrg('/', ORG)).toBe(false);
    expect(keyBelongsToOrg('   ', ORG)).toBe(false);
  });

  it('rejects an empty organizationId (fail closed, never "matches everything")', () => {
    expect(keyBelongsToOrg(`${ORG}/abc/x.jpg`, '')).toBe(false);
  });

  it('rejects traversal segments', () => {
    expect(keyBelongsToOrg(`${ORG}/../${OTHER}/x.jpg`, ORG)).toBe(false);
    expect(keyBelongsToOrg(`${ORG}/./x.jpg`, ORG)).toBe(false);
    expect(keyBelongsToOrg(`../${ORG}/x.jpg`, ORG)).toBe(false);
  });

  it('rejects encoded or backslash separators that could smuggle a second segment', () => {
    expect(keyBelongsToOrg(`${ORG}%2F..%2F${OTHER}/x.jpg`, ORG)).toBe(false);
    expect(keyBelongsToOrg(`${ORG}\\..\\${OTHER}\\x.jpg`, ORG)).toBe(false);
  });
});

describe('orgOfKey', () => {
  it('returns the first segment, slash-prefixed or not', () => {
    expect(orgOfKey(`${ORG}/a/b.jpg`)).toBe(ORG);
    expect(orgOfKey(`/${ORG}/a/b.jpg`)).toBe(ORG);
  });

  it('returns null for a key with no org segment or a refused shape', () => {
    expect(orgOfKey('photo.jpg')).toBeNull();
    expect(orgOfKey('')).toBeNull();
    expect(orgOfKey(`${ORG}/../x.jpg`)).toBeNull();
  });
});

describe('keyInUploadFolder', () => {
  const ORG = 'org-1';
  const UP = 'a'.repeat(64);

  it('accepts a file directly inside the issued folder, either key style', () => {
    expect(keyInUploadFolder(`${ORG}/${UP}/clip.mp4`, ORG, UP)).toBe(true);
    expect(keyInUploadFolder(`/${ORG}/${UP}/clip.mp4`, ORG, UP)).toBe(true);
  });

  it.each([
    ['another upload folder', `${ORG}/${'b'.repeat(64)}/clip.mp4`],
    ['another organisation', `org-2/${UP}/clip.mp4`],
    ['one level too deep', `${ORG}/${UP}/sub/clip.mp4`],
    ['the folder itself', `${ORG}/${UP}`],
    ['a trailing slash', `${ORG}/${UP}/`],
    ['a traversal', `${ORG}/${UP}/../x.mp4`],
    ['an encoded separator', `${ORG}/${UP}%2Fclip.mp4`],
    ['a backslash', `${ORG}\\${UP}\\clip.mp4`],
    ['an empty key', ''],
  ])('refuses %s', (_name, key) => {
    expect(keyInUploadFolder(key, ORG, UP)).toBe(false);
  });

  it('refuses ids that could themselves be paths', () => {
    expect(keyInUploadFolder(`${ORG}/${UP}/clip.mp4`, ORG, '')).toBe(false);
    expect(keyInUploadFolder(`${ORG}/${UP}/clip.mp4`, '', UP)).toBe(false);
    expect(keyInUploadFolder('x/y/z', 'x/y', 'z')).toBe(false);
  });
});
