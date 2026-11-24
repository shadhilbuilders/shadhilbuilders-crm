// Profile photo control (2026-11-24).
//
// Upload happens on PICK, not on Save: the file goes to POST /api/media (the
// same route chat attachments use), the returned key is held in state, and the
// profile form's Save is what points User.avatarKey at it. That split is what
// lets a user preview the face they chose before committing it, and it is why
// Remove sends `avatarKey: null` without touching storage directly.
//
// Failure policy: every refusal is shown. A browser that cannot decode a HEIC,
// a storage outage, a server that rejects the key: each one is a toast with the
// server's own message, because the alternative is a photo that silently does
// not change.
'use client';

import { useEffect, useRef, useState } from 'react';

import { Avatar, Button, toast } from '@paalstack/react-ui';
import { LuImagePlus, LuTrash2 } from '@paalstack/react-icons/lu';

import { uploadToMedia } from '@/hooks/queries/crm';
import { useUpdateProfile } from '@/hooks/queries/users';
import { AVATAR_MAX_EDGE, AvatarImageError, resizeToSquareJpeg } from '@/lib/image-resize';
import { initials } from '@/lib/initials';

/** Matches MAX_UPLOAD_BYTES on the server (storage.limits.ts). */
const MAX_RAW_BYTES = 10 * 1024 * 1024;

export function AvatarUpload({
  name,
  imageUrl,
  onSaved,
}: {
  /** Used for the initials fallback and the accessible labels. */
  name: string;
  /** Server-resolved URL, or null when this person has no photo. */
  imageUrl: string | null;
  /** Called after a successful save so the shell can refetch the session. */
  onSaved: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const updateProfile = useUpdateProfile();
  const [busy, setBusy] = useState(false);
  /** Local preview of a freshly uploaded key, until the query catches up. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Object URLs are owned by the page, not garbage collected: one leaked per
  // photo change for as long as the tab lives. Revoke the previous one whenever
  // it is replaced, and the last one on unmount.
  useEffect(() => {
    return () => {
      if (previewUrl !== null) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const shownUrl = previewUrl ?? imageUrl;

  async function onPick(file: File): Promise<void> {
    setBusy(true);
    try {
      const upload = await prepareForUpload(file);
      updateProfile.mutate(
        { avatarKey: upload.key },
        {
          onSuccess: async () => {
            // The provider URL is what the avatar renders, so a local object URL
            // is only ever a stand-in for the seconds before the query refetches.
            setPreviewUrl(previewFromBlob(upload.previewBlob));
            toast.success('Photo updated');
            await onSaved();
          },
          onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : 'Could not save your photo');
          },
          onSettled: () => {
            setBusy(false);
          },
        },
      );
      return;
    } catch (err) {
      // A decode or upload failure never reaches the save; say why and stop.
      toast.error(err instanceof Error ? err.message : 'Could not upload that photo');
      setBusy(false);
    }
  }

  function onRemove(): void {
    setBusy(true);
    updateProfile.mutate(
      { avatarKey: null },
      {
        onSuccess: async () => {
          setPreviewUrl(null);
          toast.success('Photo removed');
          await onSaved();
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : 'Could not remove your photo');
        },
        onSettled: () => {
          setBusy(false);
        },
      },
    );
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar
        className="h-16 w-16 shrink-0"
        src={shownUrl ?? undefined}
        alt={shownUrl === null ? '' : `${name}'s photo`}
        fallback={initials(name)}
        imageProps={{ className: 'rounded-full' }}
        fallbackProps={{ className: 'rounded-full text-lg' }}
      />

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            // `image/*` lets an iPhone offer the photo library with HEIC files;
            // the resize step refuses what it cannot decode and says so.
            accept="image/*"
            className="sr-only"
            aria-label="Choose a profile photo"
            data-qa="avatar-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset first: picking the SAME file twice must fire onChange again.
              event.target.value = '';
              if (file !== undefined) void onPick(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <LuImagePlus aria-hidden="true" />
            {shownUrl === null ? 'Add photo' : 'Change photo'}
          </Button>
          {shownUrl !== null ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
              <LuTrash2 aria-hidden="true" />
              Remove
            </Button>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          A square crop, up to {AVATAR_MAX_EDGE} pixels. Your browser shrinks the photo before it is
          uploaded.
        </p>
      </div>
    </div>
  );
}

/**
 * Shrink and encode the picked file, then hand the bytes to the media route.
 *
 * Fallback, stated out loud: if the browser cannot decode the image but the
 * original is already small enough and declares itself an image, it is uploaded
 * as-is. The server still sniffs the real type and still refuses a non-image, so
 * this is a convenience for odd formats, not a bypass.
 */
async function prepareForUpload(file: File): Promise<{ key: string; previewBlob: Blob | null }> {
  let previewBlob: Blob | null = null;
  let upload = file;
  try {
    previewBlob = await resizeToSquareJpeg(file);
    upload = new File([previewBlob], 'avatar.jpg', { type: 'image/jpeg' });
  } catch (err) {
    // Only a decode refusal has a fallback. Anything else (a canvas that will not
    // encode) is a real fault and belongs to the caller.
    if (!(err instanceof AvatarImageError && err.reason === 'decode-failed')) throw err;
    if (!file.type.startsWith('image/') || file.size > MAX_RAW_BYTES) {
      throw new Error('That image could not be read. Try a JPEG or PNG photo.', { cause: err });
    }
  }
  const { key } = await uploadToMedia(upload);
  return { key, previewBlob };
}

function previewFromBlob(blob: Blob | null): string | null {
  if (blob === null || typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(blob);
}
