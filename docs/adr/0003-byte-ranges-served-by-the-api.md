# ADR-0003: The API cuts byte ranges when the CDN will not

**Date**: 2026-11-24
**Status**: accepted
**Deciders**: Paalamugan S

## Context

Site update clips are served from `/api/media/:key` behind a signed ImageKit URL. The route
asks the provider for a byte range and streams whatever comes back, and it reports the
provider's status honestly instead of relabelling a 200 as a 206.

Measured on production on 2026-11-24: a ranged request comes back `200` with the whole object,
1,700,682 bytes for a 15 second clip. Safari will not seek a media response that arrived with a
200, so the player's scrubber is dead until the transfer finishes, and the device gate row that
asks for "seek works" cannot pass. The 14 MiB ceiling means the worst case is bounded.

## Decision

`MediaController.streamVideo` cuts the requested window itself when a range was asked for and
the provider answered `200`. It skips forward from byte 0 of the stream it was handed, stops at
the window's end, answers `206` with a truthful `Content-Range`, and destroys the upstream
connection as soon as the window is complete.

## Alternatives Considered

### Serve the 200 and accept that seeking is unavailable

- **Pros**: no server code, no extra load, and the clip still plays from the start.
- **Cons**: every seek re-downloads from byte 0 on the client, and Safari disables seeking
  outright, which fails a stated row of the device gate.
- **Why not**: it is the one behaviour a phone test will call broken, and it is cheap to fix.

### Sign a different URL, or move clips to a CDN that honours Range

- **Pros**: the fix lives where the limitation does, and the API stays a pass-through.
- **Cons**: needs a second storage path, a second key space, or a provider migration; the
  private-file rule (both objects verified private at record time) is part of why the signed
  URL exists.
- **Why not**: a migration is not justified while the ceiling is 14 MiB. Revisit if clips grow
  or if the CDN starts honouring ranges.

### Buffer the object and cache it server-side, then slice

- **Pros**: a seek costs no transfer after the first read.
- **Cons**: 14 MiB per concurrent viewer held in memory, plus a cache with an eviction policy
  and a staleness story.
- **Why not**: the simple cut is correct with no new state. Add the cache only if a measured
  trace shows the re-transfer hurting.

## Consequences

### Positive

- Seeking works on every browser, and the response tells the truth about what it sent.
- The 206 path is now covered by tests for a closed window and an open-ended one.

### Negative

- One ranged request still transfers the whole object from the CDN; only the bytes written to
  the browser are reduced. CDN egress is unchanged.

### Risks

- A provider that one day honours ranges upstream takes the same path with `status === 206`,
  and the cut is skipped, which is the intended behaviour. The condition is
  `range !== undefined && object.status === 200`, so a 206 never reaches the slicing code.
- If the provider omits `content-length`, the size comes from `stat()`, which is one extra call
  on that path only.
