// The recorder's state machine (plan section 6), as a pure reducer so every
// transition is testable without a camera:
//
//   idle -> requesting -> denied-temporary | denied-permanent | unsupported
//        -> recording -> stopping -> preview -> uploading -> saving -> done | failed
//
// An event that is not legal in the current state is IGNORED (the state comes
// back unchanged): a late tick from a MediaRecorder callback after Close must not
// resurrect a screen.
export interface Clip {
  blob: Blob;
  durationMs: number;
  hasAudio: boolean;
  /** Always present for a clip that reaches `preview`: the real frame, or a placeholder. */
  poster: Blob;
}

export type Step =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'denied-temporary' }
  | { kind: 'denied-permanent' }
  | { kind: 'unsupported' }
  | { kind: 'recording' }
  | { kind: 'stopping' }
  | { kind: 'preview'; clip: Clip }
  | { kind: 'uploading'; clip: Clip; percent: number | null }
  | { kind: 'saving'; clip: Clip }
  | { kind: 'done' }
  | { kind: 'failed'; clip: Clip; message: string; retryable: boolean };

export interface RecorderState {
  /** Fixed once recording starts: the microphone track is part of the stream. */
  audio: boolean;
  step: Step;
}

export type RecorderEvent =
  | { type: 'OPEN' }
  | { type: 'TOGGLE_AUDIO' }
  | { type: 'GRANTED' }
  | { type: 'DENIED'; permanent: boolean }
  | { type: 'UNSUPPORTED' }
  | { type: 'STOP' }
  | { type: 'TOO_SHORT' }
  | { type: 'LOAD_CLIP'; clip: Clip }
  | { type: 'STOPPED'; clip: Clip }
  | { type: 'RETAKE' }
  | { type: 'USE' }
  | { type: 'PROGRESS'; percent: number | null }
  | { type: 'UPLOADED' }
  | { type: 'SAVED' }
  | { type: 'FAIL'; message: string; retryable: boolean }
  | { type: 'RETRY' }
  | { type: 'CLOSE' };

/** Audio defaults OFF: site noise and bystanders are recorded only on purpose. */
export const INITIAL_RECORDER_STATE: RecorderState = { audio: false, step: { kind: 'idle' } };

const CLIP_KINDS = new Set<Step['kind']>(['preview', 'uploading', 'saving', 'failed']);

function clipOf(step: Step): Clip | null {
  return CLIP_KINDS.has(step.kind) ? (step as Extract<Step, { clip: Clip }>).clip : null;
}

const set = (state: RecorderState, step: Step): RecorderState => ({ ...state, step });

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  const { step } = state;
  switch (event.type) {
    case 'CLOSE':
      // Closing always returns to idle and discards the take: nothing was saved.
      return { audio: state.audio, step: { kind: 'idle' } };
    case 'TOGGLE_AUDIO':
      return step.kind === 'idle' || step.kind === 'denied-temporary'
        ? { ...state, audio: !state.audio }
        : state;
    case 'OPEN':
      return step.kind === 'idle' || step.kind === 'denied-temporary'
        ? set(state, { kind: 'requesting' })
        : state;
    case 'GRANTED':
      return step.kind === 'requesting' ? set(state, { kind: 'recording' }) : state;
    case 'DENIED':
      return step.kind === 'requesting'
        ? set(state, { kind: event.permanent ? 'denied-permanent' : 'denied-temporary' })
        : state;
    case 'UNSUPPORTED':
      return step.kind === 'requesting' || step.kind === 'idle'
        ? set(state, { kind: 'unsupported' })
        : state;
    case 'STOP':
      return step.kind === 'recording' ? set(state, { kind: 'stopping' }) : state;
    case 'LOAD_CLIP':
      // A clip picked from the gallery skips the camera and goes straight to review.
      return step.kind === 'idle' ? set(state, { kind: 'preview', clip: event.clip }) : state;
    case 'TOO_SHORT':
      // A tap shorter than the minimum is discarded; the sheet stays open, ready.
      return step.kind === 'stopping' || step.kind === 'recording'
        ? set(state, { kind: 'idle' })
        : state;
    case 'STOPPED':
      return step.kind === 'stopping' || step.kind === 'recording'
        ? set(state, { kind: 'preview', clip: event.clip })
        : state;
    case 'RETAKE':
      return step.kind === 'preview' || step.kind === 'failed'
        ? set(state, { kind: 'requesting' })
        : state;
    case 'USE':
      return step.kind === 'preview'
        ? set(state, { kind: 'uploading', clip: step.clip, percent: 0 })
        : state;
    case 'PROGRESS':
      return step.kind === 'uploading' ? set(state, { ...step, percent: event.percent }) : state;
    case 'UPLOADED':
      return step.kind === 'uploading' ? set(state, { kind: 'saving', clip: step.clip }) : state;
    case 'SAVED':
      return step.kind === 'saving' ? set(state, { kind: 'done' }) : state;
    case 'FAIL': {
      const clip = clipOf(step);
      return clip !== null && (step.kind === 'uploading' || step.kind === 'saving')
        ? set(state, { kind: 'failed', clip, message: event.message, retryable: event.retryable })
        : state;
    }
    case 'RETRY':
      return step.kind === 'failed' && step.retryable
        ? set(state, { kind: 'uploading', clip: step.clip, percent: 0 })
        : state;
  }
}

/** The one spoken line per state: the live region announces states, never seconds. */
export function announcementFor(step: Step): string {
  switch (step.kind) {
    case 'recording':
      return 'Recording';
    case 'stopping':
      return 'Recording stopped';
    case 'preview':
      return 'Recording stopped. Review your clip.';
    case 'uploading':
      return step.percent === null ? 'Uploading' : `Uploading, ${Math.round(step.percent)} percent`;
    case 'saving':
      return 'Saving';
    case 'done':
      return 'Update saved';
    case 'failed':
      return step.message;
    default:
      return '';
  }
}
