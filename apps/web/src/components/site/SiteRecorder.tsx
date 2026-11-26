'use client';

// SiteRecorder (plan section 6): the full-screen video recorder for one unit.
//
// The browser work lives in RecorderEngine; the screen's state lives in the pure
// recorderReducer; the upload and its Retry live in TakeUploader (via
// useVideoSave). This component only wires the three together and draws the
// current step. The live region announces STATES, never the seconds.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  Badge,
  Button,
  Progress,
  Select,
  Sheet,
  Switch,
  Textarea,
  toast,
} from '@paalstack/react-ui';
import { LuImages, LuMic, LuMicOff, LuSquare, LuVideo, LuX } from '@paalstack/react-icons/lu';

import { useVideoSave } from '@/hooks/queries/site-video';
import type { TimelinePhoto } from '@/hooks/queries/customer-progress';
import { CONSTRUCTION_STAGE_ORDER, constructionStageLabel } from '@/lib/labels';
import {
  MAX_VIDEO_MS,
  MIN_VIDEO_MS,
  STOP_BUTTON_PX,
  COUNTDOWN_MS,
} from '@/lib/site-video/constants';
import {
  UploadCancelledError,
  isRetryableVideoError,
  videoErrorMessage,
} from '@/lib/site-video/errors';
import { browserFinalizeDeps, finalizeClip } from '@/lib/site-video/finalize-clip';
import { formatClock } from '@/lib/site-video/format';
import {
  INITIAL_RECORDER_STATE,
  announcementFor,
  recorderReducer,
  type Clip,
} from '@/lib/site-video/recorder-machine';
import { RecorderEngine, browserRecorderEnv, type RawTake } from '@/lib/site-video/recorder-engine';
import {
  cameraPermissionState,
  supportsAudio,
  zoomStops,
  type ZoomCapability,
} from '@/lib/site-video/recorder-support';
import {
  EMPTY_TIMINGS,
  elapsed as elapsedMs,
  stamp,
  timingLines,
  timingsRequested,
  type TakeTimings,
} from '@/lib/site-video/recorder-timings';

const STAGE_UNSET = '__unset__';
const STAGE_OPTIONS = [
  { value: STAGE_UNSET, label: 'Stage not set' },
  ...CONSTRUCTION_STAGE_ORDER.map((value) => ({ value, label: constructionStageLabel(value) })),
];
const CAPTION_MAX = 280;

export interface SiteRecorderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: string;
  unitNumber: string;
  phaseId: string;
  /** The stage the unit is currently at, used as the starting pick. */
  defaultStage: string | null;
  onSaved: (photo: TimelinePhoto) => void;
  /** Offered when the camera cannot be used: open the file picker for a video instead. */
  onChooseFile: () => void;
  /** A clip already chosen from the gallery: skips the camera and opens on the review. */
  initialClip?: Clip | null;
}

export function SiteRecorder(props: SiteRecorderProps) {
  const { open, onOpenChange, unitId, unitNumber, phaseId, defaultStage, onSaved, onChooseFile } =
    props;
  const [state, dispatch] = useReducer(recorderReducer, INITIAL_RECORDER_STATE);
  const [elapsed, setElapsed] = useState(0);
  const [stage, setStage] = useState<string | null>(defaultStage);
  const [caption, setCaption] = useState('');
  // The camera's own zoom, when it has one (2026-11-26). Null on a platform
  // that exposes no range, which is how the control stays absent rather than
  // dead on an iPhone.
  const [zoom, setZoom] = useState<{ capability: ZoomCapability; value: number } | null>(null);
  // Device gate readout (2026-11-26): measured, never typed in by hand. Absent
  // unless the page was opened with ?timings=1.
  const [timings, setTimings] = useState<TakeTimings>(EMPTY_TIMINGS);
  const timingsRef = useRef<TakeTimings>(EMPTY_TIMINGS);
  const showTimingsRef = useRef(false);
  const recordTiming = useCallback((next: Partial<TakeTimings>) => {
    timingsRef.current = { ...timingsRef.current, ...next };
    setTimings(timingsRef.current);
  }, []);
  const [showTimings, setShowTimings] = useState(false);
  const liveRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<RecorderEngine | null>(null);
  const takenAtRef = useRef<string>(new Date().toISOString());
  const { save, cancel } = useVideoSave(unitId);
  // Capability, not a guess: a browser can record avc1 without AAC, and its
  // MediaRecorder then drops the audio track silently. Where it cannot mux AAC,
  // the toggle is not offered and `begin` asks for no audio at all.
  const audioSupported = supportsAudio(
    typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
  );
  const audioRef = useRef(state.audio && audioSupported);
  audioRef.current = state.audio && audioSupported;
  // Read at open time only: a background refetch of the unit must never restart the camera.
  const initialClipRef = useRef(props.initialClip ?? null);
  initialClipRef.current = props.initialClip ?? null;
  const defaultStageRef = useRef(defaultStage);
  defaultStageRef.current = defaultStage;

  const begin = useCallback(async () => {
    const engine = engineRef.current;
    if (engine === null) return;
    setElapsed(0);
    takenAtRef.current = new Date().toISOString();
    dispatch({ type: 'OPEN' });
    const tappedAt = stamp();
    await engine.start(audioRef.current);
    // Tap to running, the first of the four gate numbers.
    recordTiming({ recordStartMs: elapsedMs(tappedAt, stamp()) });
  }, []);

  // Route A: the camera zooms ITSELF. A stop applied mid-clip keeps the
  // recording going - only what the sensor sees changes - so there is no pause,
  // no second encode and nothing added to the upload path.
  const applyZoom = useCallback(async (value: number) => {
    const engine = engineRef.current;
    if (engine === null) return;
    const accepted = await engine.setZoom(value);
    if (accepted) setZoom(engine.zoomState());
  }, []);

  // Engine lives for the sheet's open lifetime. Handlers only dispatch.
  useEffect(() => {
    if (!open) return;
    const asked = timingsRequested(window.location.search);
    showTimingsRef.current = asked;
    setShowTimings(asked);
    const engine = new RecorderEngine(browserRecorderEnv(), {
      onGranted: (stream) => {
        dispatch({ type: 'GRANTED' });
        if (liveRef.current !== null) liveRef.current.srcObject = stream;
        // null on iOS Safari and on any camera that reports no zoom range.
        setZoom(engine.zoomState());
      },
      onDenied: (permanent) => dispatch({ type: 'DENIED', permanent }),
      onUnsupported: () => dispatch({ type: 'UNSUPPORTED' }),
      onTick: setElapsed,
      onTooShort: () => {
        dispatch({ type: 'TOO_SHORT' });
        toast.error('Hold for at least 1 second.');
      },
      onStopped: (take: RawTake) => {
        void finalizeClip(take, browserFinalizeDeps()).then(
          (clip) => dispatch({ type: 'STOPPED', clip }),
          () => {
            dispatch({ type: 'CLOSE' });
            toast.error(videoErrorMessage({ code: 'VIDEO_POSTER_INVALID' }));
          },
        );
      },
    });
    engineRef.current = engine;
    setStage(defaultStageRef.current);
    setCaption('');
    // Warm the camera while the sheet's own idle screen shows, so Record costs a
    // tap instead of 3.3 seconds (measured on an iPhone 2026-11-26). Only when
    // the camera is ALREADY allowed: an unprompted permission dialog the moment
    // a sheet opens would be a surprise, so a first-time user still gets it on
    // their own tap.
    void (async () => {
      const state = await cameraPermissionState();
      // Denied is the one answer worth obeying: no nagging on every sheet open.
      if (state !== 'denied') await engine.prepare(audioRef.current);
    })();
    const picked = initialClipRef.current;
    if (picked !== null) dispatch({ type: 'LOAD_CLIP', clip: picked });
    // NOT auto-started: the sheet opens on its idle state with Record and the
    // Audio toggle. A MediaRecorder's tracks are fixed when it starts, so audio
    // has to be chosen BEFORE the first frame - an audio switch on the recording
    // screen could only lie about the take in flight.

    // A backgrounded tab loses its camera on most phones: drop the take cleanly.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        engine.release();
        setZoom(null);
        dispatch({ type: 'CLOSE' });
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      engine.release();
      engineRef.current = null;
      setZoom(null);
      dispatch({ type: 'CLOSE' });
    };
  }, [open, begin]);

  // The live <video> mounts when recording starts. On a cold start onGranted has
  // already handed it the stream; on a warmed sheet the stream existed before the
  // element did, so it is attached here instead (2026-11-26).
  useEffect(() => {
    const video = liveRef.current;
    if (video === null) return;
    video.muted = true;
    const stream = engineRef.current?.currentStream() ?? null;
    if (stream !== null && video.srcObject !== stream) video.srcObject = stream;
  }, [state.step.kind]);

  const step = state.step;
  const remaining = Math.max(0, MAX_VIDEO_MS - elapsed);
  const counting = step.kind === 'recording' && RecorderEngine.inCountdown(elapsed);

  const runUpload = useCallback(
    async (clip: Clip) => {
      const useTappedAt = stamp();
      // What the clip IS is known before it is sent; only the upload time is not.
      recordTiming({ clipBytes: clip.blob.size, clipMs: clip.durationMs });
      try {
        const photo = await save({
          clip,
          phaseId,
          takenAt: takenAtRef.current,
          // The gate's numbers ride with the take, so a phone never has to show
          // them to anyone: the server logs what the device measured.
          ...(showTimingsRef.current
            ? {
                timings: {
                  recordStartMs: timingsRef.current.recordStartMs,
                  uploadMs: timingsRef.current.uploadMs,
                  playbackMs: timingsRef.current.playbackMs,
                  clipMs: timingsRef.current.clipMs,
                  clipBytes: timingsRef.current.clipBytes,
                },
              }
            : {}),
          ...(caption.trim().length > 0 ? { caption: caption.trim() } : {}),
          ...(stage !== null ? { stage } : {}),
          onProgress: (percent) => {
            dispatch({ type: 'PROGRESS', percent });
            if (percent >= 100) dispatch({ type: 'UPLOADED' });
          },
        });
        // Tap Use clip to the server confirming it, plus what the browser made.
        recordTiming({ uploadMs: elapsedMs(useTappedAt, stamp()) });
        // A very small clip can finish without a visible 100: make sure `saving` is reached.
        dispatch({ type: 'UPLOADED' });
        dispatch({ type: 'SAVED' });
        toast.success('Update saved');
        onSaved(photo);
        onOpenChange(false);
      } catch (err) {
        if (err instanceof UploadCancelledError) return;
        dispatch({
          type: 'FAIL',
          message: videoErrorMessage(err),
          retryable: isRetryableVideoError(err),
        });
      }
    },
    [save, phaseId, caption, stage, onSaved, onOpenChange],
  );

  const close = useCallback(() => {
    void cancel();
    onOpenChange(false);
  }, [cancel, onOpenChange]);

  const live = announcementFor(step);
  const timingText = timingLines(timings).join('  |  ');

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : close())}
        trigger={null}
        side="bottom"
        header={{ title: `Record a clip: ${unitNumber}` }}
        // Full-screen sheet: its first row is the Close button, and without the
        // top inset that row lands under the status bar on a notched iPhone, so
        // the sheet looks like it has no way out (2026-11-24).
        className="h-[100dvh] p-0 pt-[env(safe-area-inset-top)]"
      >
        <div className="bg-background flex h-full flex-col" data-qa="recorder-sheet">
          <div className="sr-only" role="status" aria-live="polite" data-qa="recorder-live">
            {live}
          </div>

          <div className="flex items-center justify-between gap-2 p-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close recorder"
              onClick={close}
              className="size-11 focus-visible:ring-2"
              data-qa="recorder-close"
            >
              <LuX aria-hidden />
            </Button>
            {step.kind === 'recording' ? (
              <span
                role="timer"
                aria-live="off"
                className={`text-lg font-semibold tabular-nums ${counting ? 'text-destructive' : ''}`}
                data-qa="recorder-timer"
              >
                {counting ? `${formatClock(remaining)} left` : formatClock(elapsed)}
              </span>
            ) : null}
            {step.kind === 'idle' || step.kind === 'denied-temporary' ? (
              audioSupported ? (
                <label className="flex items-center gap-2 text-sm">
                  {state.audio ? <LuMic aria-hidden /> : <LuMicOff aria-hidden />}
                  Audio
                  <Switch
                    checked={state.audio}
                    onCheckedChange={() => {
                      dispatch({ type: 'TOGGLE_AUDIO' });
                      // The stream carries the audio choice: re-open it so the
                      // next take matches the switch instead of the old stream.
                      void engineRef.current?.prepare(!audioRef.current);
                    }}
                    data-qa="recorder-audio"
                  />
                </label>
              ) : (
                // One honest word, not a switch that cannot work on this browser.
                <Badge variant="secondary" data-qa="recorder-audio-unavailable">
                  Audio unavailable
                </Badge>
              )
            ) : (
              <Badge variant="secondary">{state.audio ? 'Audio on' : 'Audio off'}</Badge>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4">
            {(step.kind === 'requesting' ||
              step.kind === 'recording' ||
              step.kind === 'stopping') && (
              <video
                ref={liveRef}
                autoPlay
                muted
                playsInline
                className="max-h-full w-full max-w-md rounded-lg bg-black object-contain"
                data-qa="recorder-live-video"
              />
            )}

            {/* Zoom applies WHILE recording: each stop is one applyConstraints on
              the track the recorder already holds. 44px tall so it meets the
              same tap-target floor as the stop control. */}
            {step.kind === 'recording' && zoom !== null ? (
              <div
                className="flex flex-wrap items-center justify-center gap-2"
                data-qa="recorder-zoom"
              >
                {zoomStops(zoom.capability).map((stop) => {
                  const active = Math.abs(stop.value - zoom.value) < 1e-9;
                  return (
                    <Button
                      key={stop.label}
                      type="button"
                      size="sm"
                      variant={active ? 'default' : 'outline'}
                      aria-pressed={active}
                      className="h-11 min-w-11 tabular-nums"
                      data-qa={`recorder-zoom-${stop.label}`}
                      onClick={() => void applyZoom(stop.value)}
                    >
                      {stop.label}
                    </Button>
                  );
                })}
              </div>
            ) : null}

            {step.kind === 'idle' && (
              <Button type="button" size="lg" onClick={() => void begin()} data-qa="recorder-start">
                <LuVideo aria-hidden /> Record
              </Button>
            )}

            {(step.kind === 'denied-temporary' ||
              step.kind === 'denied-permanent' ||
              step.kind === 'unsupported') && (
              <PermissionPanel
                kind={step.kind}
                onRetry={() => void begin()}
                onChooseFile={() => {
                  close();
                  onChooseFile();
                }}
              />
            )}

            {step.kind === 'preview' && (
              <ReviewPanel
                clip={step.clip}
                stage={stage}
                caption={caption}
                onStage={setStage}
                onCaption={setCaption}
                onOpenMs={(ms) => recordTiming({ playbackMs: ms })}
              />
            )}

            {(step.kind === 'uploading' || step.kind === 'saving') && (
              <div className="flex w-full max-w-md flex-col gap-3" data-qa="upload-panel">
                <Progress
                  value={step.kind === 'uploading' ? step.percent : 100}
                  aria-label="Upload progress"
                  data-qa="upload-progress"
                />
                <p className="text-muted-foreground text-sm">
                  {step.kind === 'saving' ? 'Saving…' : 'Uploading…'}
                </p>
              </div>
            )}

            {step.kind === 'failed' && (
              <p
                role="alert"
                className="text-destructive max-w-md text-center text-sm"
                data-qa="video-error"
              >
                {step.message}
              </p>
            )}
          </div>

          <div className="flex items-center justify-center gap-3 border-t px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {step.kind === 'recording' && (
              <Button
                type="button"
                size="icon"
                aria-label="Stop recording"
                onClick={() => {
                  dispatch({ type: 'STOP' });
                  engineRef.current?.stop();
                }}
                style={{ width: STOP_BUTTON_PX, height: STOP_BUTTON_PX }}
                className="rounded-full focus-visible:ring-2 focus-visible:ring-offset-2"
                data-qa="recorder-stop"
              >
                <LuSquare aria-hidden />
              </Button>
            )}
            {step.kind === 'preview' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 min-w-28"
                  onClick={() => {
                    dispatch({ type: 'RETAKE' });
                    void begin();
                  }}
                  data-qa="video-retake"
                >
                  Retake
                </Button>
                <Button
                  type="button"
                  className="h-11 min-w-28"
                  onClick={() => {
                    dispatch({ type: 'USE' });
                    void runUpload(step.clip);
                  }}
                  data-qa="video-save"
                >
                  Use clip
                </Button>
              </>
            )}
            {(step.kind === 'uploading' || step.kind === 'saving') && (
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                onClick={close}
                data-qa="upload-cancel"
              >
                Cancel
              </Button>
            )}
            {step.kind === 'failed' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  onClick={() => {
                    dispatch({ type: 'RETAKE' });
                    void cancel().then(() => begin());
                  }}
                  data-qa="video-retake"
                >
                  Retake
                </Button>
                {step.retryable ? (
                  <Button
                    type="button"
                    className="h-11"
                    onClick={() => {
                      dispatch({ type: 'RETRY' });
                      void runUpload(step.clip);
                    }}
                    data-qa="video-retry"
                  >
                    Retry
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </Sheet>
      {showTimings && timingText.length > 0 ? (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] bg-black/80 px-2 py-1 text-center font-mono text-[11px] leading-4 text-white"
          data-qa="recorder-timings"
          role="status"
        >
          {timingText}
        </div>
      ) : null}
    </>
  );
}

function PermissionPanel(props: {
  kind: 'denied-temporary' | 'denied-permanent' | 'unsupported';
  onRetry: () => void;
  onChooseFile: () => void;
}) {
  const copy = {
    'denied-temporary': 'The camera was not allowed. Allow it to record.',
    'denied-permanent':
      'The camera is blocked for this site. Turn it on in your browser settings, or choose a clip instead.',
    unsupported: 'This browser cannot record video here. Choose a clip from your gallery instead.',
  }[props.kind];
  return (
    <div
      className="flex max-w-md flex-col items-center gap-4 text-center"
      data-qa="recorder-permission"
    >
      <p className="text-sm" role="alert">
        {copy}
      </p>
      <div className="flex gap-3">
        {props.kind === 'denied-temporary' ? (
          <Button type="button" className="h-11" onClick={props.onRetry} data-qa="recorder-allow">
            Allow camera
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={props.onChooseFile}
          data-qa="recorder-choose-file"
        >
          <LuImages aria-hidden /> Choose a clip
        </Button>
      </div>
    </div>
  );
}

function ReviewPanel(props: {
  clip: Clip;
  stage: string | null;
  caption: string;
  onStage: (stage: string | null) => void;
  onCaption: (caption: string) => void;
  /** Gate telemetry: how long the first frame took to appear. */
  onOpenMs?: (ms: number) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  // Mount of the review is the moment the clip is opened, so this is the clock
  // the gate's playback number counts from.
  const openedAt = useRef(stamp());
  const reported = useRef(false);
  useEffect(() => {
    const next = URL.createObjectURL(props.clip.blob);
    setUrl(next);
    openedAt.current = stamp();
    reported.current = false;
    return () => URL.revokeObjectURL(next);
  }, [props.clip.blob]);

  return (
    <div className="flex w-full max-w-md flex-col gap-3" data-qa="video-review">
      {url !== null ? (
        <video
          src={url}
          controls
          playsInline
          // auto, not metadata: the review must decode its first frame so the
          // gate can time it. The clip is a blob in memory, so nothing is fetched.
          preload="auto"
          className="max-h-[45dvh] w-full rounded-lg bg-black object-contain"
          data-qa="video-preview"
          onLoadedData={() => {
            if (reported.current) return;
            reported.current = true;
            props.onOpenMs?.(elapsedMs(openedAt.current, stamp()));
          }}
        />
      ) : null}
      <Select
        value={props.stage ?? STAGE_UNSET}
        onValueChange={(next) => props.onStage(next === null || next === STAGE_UNSET ? null : next)}
        options={STAGE_OPTIONS}
        label="Construction stage"
        placeholder="Stage not set"
        data-qa="video-stage"
      />
      <Textarea
        rows={3}
        maxLength={CAPTION_MAX}
        value={props.caption}
        onValueChange={props.onCaption}
        placeholder="Plinth poured, curing until Friday"
        aria-label="Note for the customer"
        data-qa="video-caption"
      />
      <p className="text-muted-foreground text-xs">
        {formatClock(props.clip.durationMs)} - {props.clip.hasAudio ? 'with audio' : 'no audio'}
      </p>
    </div>
  );
}

// Re-exported so tests and the capture bar share the exact limits.
export { MIN_VIDEO_MS, MAX_VIDEO_MS, COUNTDOWN_MS };
