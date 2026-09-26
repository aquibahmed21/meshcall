import { Disposer, Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';

const log = createLogger('ViewMode');

export type PipState = 'inactive' | 'entering' | 'active' | 'exiting' | 'unsupported' | 'error';
export type FullscreenState = 'inactive' | 'active' | 'unsupported' | 'error';

export interface ViewModeSnapshot {
  pip: PipState;
  /** The <video> currently shown in PiP (browser truth), if it is one of ours. */
  pipVideo: HTMLVideoElement | null;
  fullscreen: FullscreenState;
  error?: string;
}

type PipDocument = Document & {
  pictureInPictureEnabled?: boolean;
  pictureInPictureElement?: Element | null;
  exitPictureInPicture?: () => Promise<void>;
};

const doc = () => document as PipDocument;

export function pipSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    doc().pictureInPictureEnabled === true &&
    typeof doc().exitPictureInPicture === 'function' &&
    typeof HTMLVideoElement !== 'undefined' &&
    typeof (HTMLVideoElement.prototype as { requestPictureInPicture?: unknown }).requestPictureInPicture === 'function'
  );
}

export function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.fullscreenEnabled === true &&
    typeof document.exitFullscreen === 'function' &&
    typeof Element.prototype.requestFullscreen === 'function'
  );
}

/**
 * Picture-in-Picture + Fullscreen for the call view.
 *
 * - PiP always uses an EXISTING tile <video> (same MediaStream, no second stream).
 * - Fullscreen targets the call container (video area + chat + controls), never the whole app.
 * - State is re-derived from document.pictureInPictureElement / document.fullscreenElement on
 *   every browser event, so closing the PiP window or pressing ESC can never desync the UI.
 * - One set of document-level listeners per controller; dispose() removes them.
 */
export class ViewModeController {
  readonly events = new Emitter<{ change: ViewModeSnapshot }>();
  private readonly canPip = pipSupported();
  private readonly canFullscreen = fullscreenSupported();
  private pipTransition: 'entering' | 'exiting' | null = null;
  /** Settles when the current PiP enter/exit request settles. */
  private pipPending: Promise<unknown> = Promise.resolve();
  /** Every video WE put into PiP – still ours even after its tile was removed from the DOM. */
  private ourPipVideos = new WeakSet<HTMLVideoElement>();
  private pipError = false;
  private fsError = false;
  private error: string | undefined;
  private disposer = new Disposer();
  private disposed = false;

  constructor(
    private readonly fullscreenTarget: HTMLElement,
    /** Is this video one of ours (a call tile)? PiP owned by other pages/elements is ignored. */
    private readonly owns: (video: HTMLVideoElement) => boolean,
  ) {
    // enter/leavepictureinpicture bubble from the <video>, so one document listener covers
    // every tile – including tiles created later – without per-element listeners.
    this.disposer.listen(document, 'enterpictureinpicture', () => this.sync());
    this.disposer.listen(document, 'leavepictureinpicture', () => this.sync());
    this.disposer.listen(document, 'fullscreenchange', () => {
      this.fsError = false;
      this.sync();
    });
    this.disposer.listen(document, 'fullscreenerror', () => {
      this.fsError = true;
      this.error = 'Fullscreen was blocked by the browser';
      log.warn(this.error);
      this.sync();
    });
  }

  get snapshot(): ViewModeSnapshot {
    const pipEl = this.canPip ? doc().pictureInPictureElement : null;
    const pipVideo = pipEl instanceof HTMLVideoElement && (this.ourPipVideos.has(pipEl) || this.owns(pipEl)) ? pipEl : null;
    let pip: PipState;
    if (!this.canPip) pip = 'unsupported';
    else if (this.pipTransition) pip = this.pipTransition;
    else if (pipVideo) pip = 'active';
    else pip = this.pipError ? 'error' : 'inactive';

    let fullscreen: FullscreenState;
    if (!this.canFullscreen) fullscreen = 'unsupported';
    else if (document.fullscreenElement === this.fullscreenTarget) fullscreen = 'active';
    else fullscreen = this.fsError ? 'error' : 'inactive';
    return { pip, pipVideo, fullscreen, error: this.error };
  }

  get pipAvailable(): boolean {
    return this.canPip;
  }

  get fullscreenAvailable(): boolean {
    return this.canFullscreen;
  }

  // ── Picture-in-Picture ───────────────────────────────────────────────────

  async enterPip(video: HTMLVideoElement): Promise<boolean> {
    if (!this.canPip || this.disposed || this.pipTransition) return false;
    if (doc().pictureInPictureElement === video) return true;
    if ((video as HTMLVideoElement & { disablePictureInPicture?: boolean }).disablePictureInPicture) return this.failPip('PiP is disabled for this video');
    if (video.readyState < HTMLMediaElement.HAVE_METADATA || !(video.srcObject as MediaStream | null)?.getVideoTracks().length) {
      return this.failPip('No video to show in picture-in-picture yet');
    }
    this.pipTransition = 'entering';
    this.pipError = false;
    this.error = undefined;
    this.emit();
    const request = (video as HTMLVideoElement & { requestPictureInPicture(): Promise<unknown> }).requestPictureInPicture();
    this.pipPending = request.catch(() => undefined);
    try {
      await request;
      this.ourPipVideos.add(video);
      log.info('Entered picture-in-picture');
      return true;
    } catch (err) {
      return this.failPip(`Picture-in-picture failed: ${errorMessage(err)}`);
    } finally {
      this.pipTransition = null;
      this.sync();
    }
  }

  async exitPip(): Promise<void> {
    if (!this.canPip) return;
    if (this.pipTransition) await this.pipPending; // never lose an exit behind an in-flight enter
    if (!doc().pictureInPictureElement || this.pipTransition) return;
    this.pipTransition = 'exiting';
    this.emit();
    try {
      const exit = doc().exitPictureInPicture!();
      this.pipPending = exit.catch(() => undefined);
      await exit;
      log.info('Left picture-in-picture');
    } catch (err) {
      log.debug('exitPictureInPicture failed', errorMessage(err)); // already closed by the user
    } finally {
      this.pipTransition = null;
      this.sync();
    }
  }

  togglePip(video: HTMLVideoElement | null): Promise<unknown> {
    if (this.snapshot.pip === 'active') return this.exitPip();
    return video ? this.enterPip(video) : Promise.resolve(this.failPip('No video selected'));
  }

  /**
   * The main participant changed while PiP is open → move PiP to the new video.
   * If the browser refuses (no user activation, no frames yet) PiP keeps showing the old one.
   */
  async followVideo(video: HTMLVideoElement | null): Promise<void> {
    const s = this.snapshot;
    if (s.pip !== 'active' || !video || s.pipVideo === video) return;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;
    await this.enterPip(video);
  }

  // ── Fullscreen ───────────────────────────────────────────────────────────

  async enterFullscreen(): Promise<boolean> {
    if (!this.canFullscreen || this.disposed) return false;
    if (document.fullscreenElement === this.fullscreenTarget) return true;
    this.fsError = false;
    this.error = undefined;
    try {
      await this.fullscreenTarget.requestFullscreen({ navigationUI: 'hide' });
      log.info('Entered fullscreen');
      return true;
    } catch (err) {
      this.fsError = true;
      this.error = `Fullscreen failed: ${errorMessage(err)}`;
      log.warn(this.error);
      this.sync();
      return false;
    }
  }

  async exitFullscreen(): Promise<void> {
    if (!this.canFullscreen || document.fullscreenElement !== this.fullscreenTarget) return;
    try {
      await document.exitFullscreen();
    } catch (err) {
      log.debug('exitFullscreen failed', errorMessage(err));
    }
  }

  toggleFullscreen(): Promise<unknown> {
    return this.snapshot.fullscreen === 'active' ? this.exitFullscreen() : this.enterFullscreen();
  }

  /** Call ended: leave both modes (only if they are ours). */
  async exitAll(): Promise<void> {
    if (this.pipTransition) await this.pipPending;
    await Promise.all([this.snapshot.pipVideo ? this.exitPip() : Promise.resolve(), this.exitFullscreen()]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.exitAll();
    this.disposer.dispose();
    this.events.removeAllListeners();
  }

  private failPip(message: string): false {
    this.pipError = true;
    this.error = message;
    log.warn(message);
    this.emit();
    return false;
  }

  private sync(): void {
    if (this.snapshot.pip === 'active') this.pipError = false;
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.events.emit('change', this.snapshot);
  }
}
