// image-resize - the browser half of the avatar pipeline (2026-11-24).
//
// protects= the 512px bound and the centre crop, and the promise that a file the
//           browser cannot decode produces a TYPED failure the UI can speak
//           instead of a silent no-op;
// fails_when= the crop stops centring (faces drift off frame), the cap is
//           skipped (a 4 MB photo goes up), or the decode error escapes as a raw
//           exception the component's catch cannot name;
// no_claim= real image decoding and JPEG encoding - jsdom has neither, so the
//           DOM half is asserted only on its refusal path. The encode path is
//           covered by the manual pass at 568x320.
import { describe, expect, it } from 'vitest';

import { AVATAR_MAX_EDGE, AvatarImageError, resizeToSquareJpeg, squareCrop } from './image-resize';

describe('squareCrop', () => {
  it('takes the centred square out of a landscape photo', () => {
    expect(squareCrop({ width: 4000, height: 3000 })).toEqual({
      sx: 500,
      sy: 0,
      side: 3000,
      out: AVATAR_MAX_EDGE,
    });
  });

  it('takes the centred square out of a portrait photo', () => {
    expect(squareCrop({ width: 1200, height: 1600 })).toEqual({
      sx: 0,
      sy: 200,
      side: 1200,
      out: AVATAR_MAX_EDGE,
    });
  });

  it('never upscales a small photo', () => {
    // Blowing 300px up to 512 adds bytes and no detail.
    expect(squareCrop({ width: 300, height: 300 }).out).toBe(300);
  });

  it('survives a zero-sized source instead of dividing by zero', () => {
    const crop = squareCrop({ width: 0, height: 0 });
    expect(crop.side).toBe(1);
    expect(crop.out).toBe(1);
  });
});

describe('resizeToSquareJpeg', () => {
  it('fails with a typed reason when the browser cannot decode images', async () => {
    // jsdom ships no createImageBitmap, and its <img> never fires load or error.
    // A browser that genuinely cannot read the bytes (a HEIC on the desktop) does
    // error, so the double below does exactly that. The component must be able to
    // name this case to the user, so the reason is part of the contract.
    const RealImage = globalThis.Image;
    class UndecodableImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    Object.defineProperty(globalThis, 'Image', {
      value: UndecodableImage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      value: () => 'blob:test',
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: () => undefined,
      configurable: true,
      writable: true,
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'face.heic', { type: 'image/heic' });

    const err = await resizeToSquareJpeg(file).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AvatarImageError);
    expect((err as AvatarImageError).reason).toBe('decode-failed');
    expect((err as AvatarImageError).message.length).toBeGreaterThan(10);

    Object.defineProperty(globalThis, 'Image', {
      value: RealImage,
      configurable: true,
      writable: true,
    });
  });
});
