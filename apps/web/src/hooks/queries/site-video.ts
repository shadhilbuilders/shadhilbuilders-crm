// Site update video client hook (plan sections 5, 6): the glue between the
// recorder screen and `TakeUploader`. Refreshes the same caches a photo save does.
import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '@/apis/client';
import type { Clip } from '@/lib/site-video/recorder-machine';
import { TakeUploader } from '@/lib/site-video/take-uploader';
import { blobToBase64, xhrPostForm, type UploadDeps } from '@/lib/site-video/upload';

import type { TimelinePhoto } from './customer-progress';

export interface SaveVideoInput {
  clip: Clip;
  phaseId: string;
  takenAt: string;
  caption?: string;
  stage?: string;
  onProgress: (percent: number) => void;
}

const browserDeps: UploadDeps = {
  api: (path, init) => api(path, init),
  postForm: xhrPostForm,
  toBase64: blobToBase64,
  now: () => Date.now(),
  randomId: () => crypto.randomUUID().replace(/-/g, ''),
};

/** One uploader per unit screen; Retry continues the same take through it. */
export function useVideoSave(unitId: string) {
  const qc = useQueryClient();
  const uploader = useMemo(() => new TakeUploader(browserDeps, unitId), [unitId]);

  const save = useCallback(
    async (input: SaveVideoInput): Promise<TimelinePhoto> => {
      const { clip, onProgress, ...meta } = input;
      const photo = await uploader.send(
        clip,
        {
          phaseId: meta.phaseId,
          takenAt: meta.takenAt,
          ...(meta.caption !== undefined ? { caption: meta.caption } : {}),
          ...(meta.stage !== undefined ? { stage: meta.stage } : {}),
        },
        onProgress,
      );
      // Same refresh a photo save does: the timeline and the unit row's counters.
      void qc.invalidateQueries({ queryKey: ['customer-progress', 'photos'] });
      void qc.invalidateQueries({ queryKey: ['inventory', 'unit', unitId] });
      void qc.invalidateQueries({ queryKey: ['inventory', 'units'] });
      return photo;
    },
    [qc, uploader, unitId],
  );

  const cancel = useCallback(() => uploader.cancel(), [uploader]);
  return { save, cancel };
}
