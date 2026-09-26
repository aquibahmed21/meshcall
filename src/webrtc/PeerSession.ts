import { BoundedSet, SerialQueue, Timer } from '../core/async';
import { Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger, errorMessage } from '../core/logger';
import type { AppConfig } from '../config';
import type { MediaKind, NegotiationMessage, PayloadOf } from '../types/signaling';
import type { IceCandidateType, PeerConnectionState, SelectedPathInfo } from '../types/state';
import { CandidateGate, candidateKey, emptyCounts, parseCandidateType } from './IceStrategy';
import type { WebRTCManager } from './WebRTCManager';

const logRtc = createLogger('WebRTC');
const logIce = createLogger('ICE');

/** Local media as seen by a peer connection. */
export interface LocalMediaSource {
  readonly stream: MediaStream;
  /** Track to send for `kind` right now (null = nothing: muted camera, viewer, …). */
  getSendTrack(kind: MediaKind): MediaStreamTrack | null;
}

export type SendFn = <T extends 'offer' | 'answer' | 'ice-candidate' | 'peer-reconnect'>(type: T, payload: PayloadOf<T>, pcId: string) => void;

export interface EncodingPatch {
  maxBitrate?: number | null;
  scaleResolutionDownBy?: number;
  maxFramerate?: number | null;
  priority?: RTCPriorityType;
  networkPriority?: RTCPriorityType;
  degradationPreference?: 'balanced' | 'maintain-framerate' | 'maintain-resolution';
}

export interface PeerSessionOptions {
  remoteId: string;
  remoteSessionId: string;
  remoteName: string;
  polite: boolean;
  send: boolean;
  receive: boolean;
  generation: number;
  remoteStream: MediaStream;
  media: LocalMediaSource;
  webrtc: WebRTCManager;
  config: AppConfig;
  signal: SendFn;
}

const MAX_PENDING_PER_PC = 150;
const MAX_OFFER_RESENDS = 2;
const KINDS: MediaKind[] = ['audio', 'video'];

function ufragOf(sdp: string | undefined): string | null {
  return sdp ? (/a=ice-ufrag:(\S+)/.exec(sdp)?.[1] ?? null) : null;
}

/**
 * One RTCPeerConnection to one remote participant.
 *
 * Implements the W3C "Perfect Negotiation" pattern:
 *   - deterministic polite/impolite roles (decided by the manager from device+session ids)
 *   - makingOffer / ignoreOffer / isSettingRemoteAnswerPending collision detection
 *   - the polite peer rolls back its own offer on glare (implicit rollback in SRD)
 *   - the impolite peer ignores the colliding offer
 * All inbound signaling is processed through a SerialQueue so SDP and ICE operations never
 * interleave.
 *
 * Every signaling message carries our pcId and the pcId we believe the remote uses, so
 * messages addressed to an older RTCPeerConnection (before a rejoin/recreate) are discarded.
 */
export class PeerSession {
  readonly pcId = uuid();
  readonly pc: RTCPeerConnection;
  readonly events = new Emitter<{ state: PeerConnectionState; track: MediaStreamTrack; stalled: string }>();
  remotePcId: string | null = null;

  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswerPending = false;
  private restartRequested = false;
  private closed = false;
  private queue = new SerialQueue();
  private paramsQueue = new SerialQueue();
  private pending = new Map<string, RTCIceCandidateInit[]>();
  private applied = new BoundedSet<string>(1000);
  private gate: CandidateGate;
  private negotiationTimer = new Timer();
  private offerResends = 0;
  private localUfrag: string | null = null;
  private remoteUfrag: string | null = null;
  private loggedTypes = new Set<string>();
  private addedTrackIds = new Set<string>();
  private desiredEncoding: Partial<Record<MediaKind, EncodingPatch>> = {};
  private _state: PeerConnectionState;

  constructor(private readonly opts: PeerSessionOptions) {
    logRtc.info(`Creating peer connection → ${opts.remoteName} (${opts.polite ? 'polite' : 'impolite'}, gen ${opts.generation})`);
    this.pc = opts.webrtc.createPeerConnection();
    this.gate = new CandidateGate(
      {
        mode: opts.webrtc.gateMode(),
        srflxDelayMs: opts.config.ice.hostOnlyWindowMs,
        relayDelayMs: opts.config.ice.directP2PTimeoutMs,
      },
      (init) => this.sendCandidate(init),
      (reason, count) => {
        if (reason === 'connected') {
          if (count) logIce.info(`${this.name}: direct path up – ${count} relay candidate(s) sent as standby fallback`);
        } else {
          logIce.info(`${this.name}: Falling back to relay – released ${count} held candidate(s) (${reason})`);
        }
        this.patchState({ gate: this.gate.state });
      },
    );
    this._state = {
      peerId: opts.remoteId,
      pcId: this.pcId,
      generation: opts.generation,
      polite: opts.polite,
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      iceGatheringState: this.pc.iceGatheringState,
      signalingState: this.pc.signalingState,
      reconnectAttempts: 0,
      iceRestarts: 0,
      recreations: opts.generation,
      gate: this.gate.state,
      localCandidates: emptyCounts(),
      remoteCandidates: emptyCounts(),
      iceErrors: [],
      createdAt: Date.now(),
    };
    this.wire();
  }

  get name(): string {
    return this.opts.remoteName;
  }
  get remoteId(): string {
    return this.opts.remoteId;
  }
  get remoteSessionId(): string {
    return this.opts.remoteSessionId;
  }
  get state(): PeerConnectionState {
    return this._state;
  }
  get isClosed(): boolean {
    return this.closed;
  }
  get isConnected(): boolean {
    return this.pc.connectionState === 'connected';
  }

  /** Offerer side: add transceivers → negotiationneeded → offer. */
  startAsOfferer(): void {
    const direction = this.direction();
    for (const kind of KINDS) {
      const track = this.opts.send ? this.opts.media.getSendTrack(kind) : null;
      this.pc.addTransceiver(track ?? kind, { direction, streams: [this.opts.media.stream] });
    }
  }

  handleSignal(msg: NegotiationMessage): void {
    void this.queue.run(() => this.process(msg));
  }

  /** ICE restart – new ICE credentials, fresh gathering, P2P gets another chance first. */
  restartIce(reason: string): void {
    if (this.closed) return;
    this.restartRequested = true;
    this.patchState({ iceRestarts: this._state.iceRestarts + 1 });
    logIce.info(`${this.name}: ICE restart (${reason}) – will try direct P2P again`);
    if (typeof this.pc.restartIce === 'function') {
      this.pc.restartIce(); // fires negotiationneeded (now or once stable)
    } else {
      void this.negotiate({ iceRestart: true });
    }
  }

  setReconnectAttempts(n: number): void {
    if (n === this._state.reconnectAttempts) return; // no-op updates must not re-emit (listeners react to state)
    this.patchState({ reconnectAttempts: n });
  }

  async replaceTrack(kind: MediaKind, track: MediaStreamTrack | null): Promise<void> {
    if (this.closed || !this.opts.send) return;
    const t = this.transceiverFor(kind);
    if (!t || t.sender.track === track) return;
    try {
      await t.sender.replaceTrack(track);
      logRtc.debug(`${this.name}: replaced ${kind} track (${track ? track.label || track.id : 'none'})`);
    } catch (err) {
      logRtc.error(`${this.name}: replaceTrack(${kind}) failed`, errorMessage(err));
    }
  }

  /** Apply RTCRtpSender encoding parameters without renegotiation. Re-applied after reconnects. */
  setEncoding(kind: MediaKind, patch: EncodingPatch): Promise<boolean | undefined> {
    this.desiredEncoding[kind] = { ...this.desiredEncoding[kind], ...patch };
    return this.applyEncoding(kind);
  }

  getSender(kind: MediaKind): RTCRtpSender | null {
    return this.transceiverFor(kind)?.sender ?? null;
  }

  updateSelectedPath(path: SelectedPathInfo | undefined): void {
    const prev = this._state.selectedPath;
    if (path && prev?.pairLabel === path.pairLabel && prev.transport === path.transport) return;
    if (path) {
      logIce.info(`${this.name}: Selected candidate pair = ${path.pairLabel} (${path.connectionType}, ${path.transport})`);
    }
    this.patchState({ selectedPath: path, selectedCandidateType: path?.localType });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    logRtc.info(`Closing peer connection → ${this.name} (${reason})`);
    this.queue.close();
    this.paramsQueue.close();
    this.gate.dispose();
    this.negotiationTimer.clear();
    this.pending.clear();
    const pc = this.pc;
    pc.onnegotiationneeded = pc.onicecandidate = pc.onicecandidateerror = null;
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onicegatheringstatechange = null;
    pc.onsignalingstatechange = pc.ontrack = null;
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    for (const t of this.opts.remoteStream.getTracks()) {
      if (this.addedTrackIds.has(t.id)) this.opts.remoteStream.removeTrack(t);
    }
    this.addedTrackIds.clear();
    this.patchState({ connectionState: 'closed', iceConnectionState: 'closed', signalingState: 'closed' });
    this.events.removeAllListeners();
  }

  // ── wiring ───────────────────────────────────────────────────────────────

  private wire(): void {
    const pc = this.pc;
    pc.onnegotiationneeded = () => void this.negotiate({});

    pc.onicecandidate = ({ candidate }) => {
      if (this.closed) return;
      if (!candidate) {
        const c = this._state.localCandidates;
        logIce.debug(`${this.name}: gathering complete (host ${c.host}, srflx ${c.srflx}, relay ${c.relay})`);
        if (c.srflx === 0 && this.opts.config.hasStun && this.opts.webrtc.gateMode() !== 'native') {
          logIce.throttled('no-srflx', 60_000, 'WARN', 'No STUN (srflx) candidates gathered – STUN unreachable or UDP blocked');
        }
        this.gate.gatheringComplete();
        return;
      }
      if (!candidate.candidate) return; // empty end-of-candidates marker
      const type = (candidate.type as IceCandidateType | null) ?? parseCandidateType(candidate.candidate);
      if (type) {
        this.patchState({ localCandidates: { ...this._state.localCandidates, [type]: this._state.localCandidates[type] + 1 } }, false);
        const key = `${this.localUfrag}:${type}`;
        if (!this.loggedTypes.has(key)) {
          this.loggedTypes.add(key);
          const label = type === 'host' ? 'Host' : type === 'srflx' ? 'STUN (srflx)' : type === 'relay' ? 'TURN relay' : 'Peer-reflexive';
          logIce.info(`${this.name}: ${label} candidate discovered (${candidate.protocol ?? '?'})`);
        }
      }
      this.gate.offer(candidate);
    };

    pc.onicecandidateerror = (e) => {
      const ev = e as RTCPeerConnectionIceErrorEvent;
      // 701 = server unreachable on one interface: very common & harmless (e.g. IPv6) → debug only
      const line = `${ev.url ?? '?'} → ${ev.errorCode} ${ev.errorText ?? ''}`.trim();
      if (!this._state.iceErrors.includes(line)) {
        this.patchState({ iceErrors: [...this._state.iceErrors, line].slice(-6) });
      }
      const level = ev.errorCode === 701 ? 'DEBUG' : 'WARN';
      logIce.throttled(`err:${ev.url}:${ev.errorCode}`, 30_000, level, `${ev.url?.startsWith('turn') ? 'TURN' : 'STUN'} error ${line}`);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      logRtc.info(`${this.name}: Connection state = ${s}`);
      const patch: Partial<PeerConnectionState> = { connectionState: s };
      if (s === 'connected') {
        this.gate.release('connected');
        if (!this._state.connectedAt) patch.timeToConnectMs = Date.now() - this._state.createdAt;
        patch.connectedAt = Date.now();
        void this.reapplyEncodings();
      } else if (s === 'failed') {
        this.gate.release('failure');
      }
      this.patchState(patch);
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      logIce.debug(`${this.name}: ICE state = ${s}`);
      if (s === 'connected' || s === 'completed') this.gate.release('connected');
      else if (s === 'disconnected' || s === 'failed') this.gate.release('failure');
      this.patchState({ iceConnectionState: s });
    };

    pc.onicegatheringstatechange = () => this.patchState({ iceGatheringState: pc.iceGatheringState });
    pc.onsignalingstatechange = () => this.patchState({ signalingState: pc.signalingState });

    pc.ontrack = ({ track }) => {
      const stream = this.opts.remoteStream;
      for (const old of stream.getTracks()) {
        if (old.kind === track.kind && old.id !== track.id) stream.removeTrack(old);
      }
      if (!stream.getTrackById(track.id)) stream.addTrack(track);
      this.addedTrackIds.add(track.id);
      logRtc.info(`${this.name}: remote ${track.kind} track received`);
      const notify = () => !this.closed && this.events.emit('track', track);
      track.addEventListener('mute', notify);
      track.addEventListener('unmute', notify);
      track.addEventListener('ended', notify);
      notify();
    };
  }

  // ── negotiation ──────────────────────────────────────────────────────────

  private async negotiate(opts: { iceRestart?: boolean }): Promise<void> {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      if (opts.iceRestart) {
        await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      } else {
        await this.pc.setLocalDescription();
      }
      this.onLocalDescriptionApplied();
      if (this.pc.signalingState !== 'have-local-offer') return;
      const iceRestart = this.restartRequested || !!opts.iceRestart;
      this.restartRequested = false;
      this.offerResends = 0;
      this.sendOffer(iceRestart);
    } catch (err) {
      logRtc.error(`${this.name}: creating offer failed`, errorMessage(err));
      this.patchState({ lastError: errorMessage(err) });
    } finally {
      this.makingOffer = false;
    }
  }

  private sendOffer(iceRestart: boolean): void {
    const desc = this.pc.localDescription;
    if (!desc || desc.type !== 'offer') return;
    this.opts.signal(
      'offer',
      { description: { type: desc.type, sdp: desc.sdp }, pcId: this.pcId, targetPcId: this.remotePcId, iceRestart },
      this.pcId,
    );
    // Watchdog: if the offer or its answer is lost (signaling blip) re-send, then escalate.
    this.negotiationTimer.start(this.opts.config.timeouts.negotiationTimeoutMs, () => {
      if (this.closed || this.pc.signalingState !== 'have-local-offer') return;
      if (this.offerResends < MAX_OFFER_RESENDS) {
        this.offerResends++;
        logRtc.warn(`${this.name}: no answer – re-sending offer (${this.offerResends}/${MAX_OFFER_RESENDS})`);
        this.sendOffer(iceRestart);
      } else {
        this.events.emit('stalled', 'no-answer');
      }
    });
  }

  private async process(msg: NegotiationMessage): Promise<void> {
    if (this.closed) return;
    const { pcId: fromPcId, targetPcId } = msg.payload;
    if (targetPcId && targetPcId !== this.pcId) {
      logRtc.debug(`${this.name}: dropping ${msg.messageType} addressed to an old connection`);
      return;
    }
    try {
      switch (msg.messageType) {
        case 'offer':
        case 'answer':
          await this.handleDescription(msg.payload.description, fromPcId);
          break;
        case 'ice-candidate':
          await this.handleRemoteCandidate(msg.payload.candidate, fromPcId);
          break;
        case 'peer-reconnect':
          logRtc.info(`${this.name}: peer is re-establishing the connection (${msg.payload.reason})`);
          break;
      }
    } catch (err) {
      logRtc.error(`${this.name}: handling ${msg.messageType} failed`, errorMessage(err));
      this.patchState({ lastError: errorMessage(err) });
    }
  }

  private async handleDescription(desc: RTCSessionDescriptionInit, fromPcId: string): Promise<void> {
    if (this.remotePcId && fromPcId !== this.remotePcId) {
      logRtc.debug(`${this.name}: ignoring ${desc.type} from stale remote connection`);
      return;
    }
    if (desc.type === 'answer' && this.pc.signalingState !== 'have-local-offer') {
      logRtc.debug(`${this.name}: ignoring stale/duplicate answer (state ${this.pc.signalingState})`);
      return;
    }
    const readyForOffer = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingRemoteAnswerPending);
    const collision = desc.type === 'offer' && !readyForOffer;
    this.ignoreOffer = !this.opts.polite && collision;
    if (this.ignoreOffer) {
      logRtc.info(`${this.name}: offer collision – impolite peer ignores remote offer`);
      return;
    }
    if (collision) logRtc.info(`${this.name}: offer collision – polite peer rolls back its offer`);

    this.settingRemoteAnswerPending = desc.type === 'answer';
    try {
      await this.pc.setRemoteDescription(desc); // implicit rollback for the polite peer
    } finally {
      this.settingRemoteAnswerPending = false;
    }
    this.remotePcId = fromPcId;

    const ufrag = ufragOf(desc.sdp);
    if (ufrag && this.remoteUfrag && ufrag !== this.remoteUfrag) logIce.info(`${this.name}: remote ICE restart detected`);
    if (ufrag) this.remoteUfrag = ufrag;

    if (desc.type === 'answer') {
      this.negotiationTimer.clear();
      this.offerResends = 0;
    } else {
      await this.attachLocalMedia();
      await this.pc.setLocalDescription();
      this.onLocalDescriptionApplied();
      const answer = this.pc.localDescription;
      if (answer) {
        this.opts.signal('answer', { description: { type: answer.type, sdp: answer.sdp }, pcId: this.pcId, targetPcId: fromPcId }, this.pcId);
      }
    }
    await this.flushPending(fromPcId);
  }

  /** New local ICE credentials → new ICE generation → re-arm the P2P window. */
  private onLocalDescriptionApplied(): void {
    const ufrag = ufragOf(this.pc.localDescription?.sdp);
    if (ufrag && ufrag !== this.localUfrag) {
      this.localUfrag = ufrag;
      this.gate.arm();
      this.patchState({ gate: this.gate.state, localCandidates: emptyCounts() }, false);
      logIce.debug(`${this.name}: new ICE generation – direct P2P window ${this.opts.config.ice.directP2PTimeoutMs} ms`);
    }
  }

  /** Answerer side: bind our tracks to the transceivers created by the remote offer. */
  private async attachLocalMedia(): Promise<void> {
    const direction = this.direction();
    for (const kind of KINDS) {
      const t = this.transceiverFor(kind);
      if (!t) continue;
      if (t.direction !== direction) t.direction = direction;
      if (!this.opts.send) continue;
      const track = this.opts.media.getSendTrack(kind);
      if (t.sender.track !== track) await t.sender.replaceTrack(track);
      try {
        t.sender.setStreams?.(this.opts.media.stream);
      } catch {
        /* setStreams unsupported – remote builds its own stream */
      }
    }
  }

  private async handleRemoteCandidate(init: RTCIceCandidateInit, fromPcId: string): Promise<void> {
    if (!init?.candidate) return;
    if (this.remotePcId && fromPcId !== this.remotePcId) {
      logIce.debug(`${this.name}: dropping candidate from stale remote connection`);
      return;
    }
    const ufragMismatch = !!init.usernameFragment && !!this.remoteUfrag && init.usernameFragment !== this.remoteUfrag;
    if (!this.remotePcId || !this.pc.remoteDescription || ufragMismatch) {
      // Arrived before the SDP it belongs to (or before a restart offer) → queue.
      const list = this.pending.get(fromPcId) ?? [];
      list.push(init);
      if (list.length > MAX_PENDING_PER_PC) list.shift();
      this.pending.set(fromPcId, list);
      return;
    }
    await this.addCandidate(init);
  }

  private async flushPending(fromPcId: string): Promise<void> {
    const list = this.pending.get(fromPcId);
    if (!list?.length) return;
    this.pending.delete(fromPcId);
    for (const c of list) await this.handleRemoteCandidate(c, fromPcId);
    for (const key of this.pending.keys()) if (key !== fromPcId) this.pending.delete(key); // other pcs are obsolete now
  }

  private async addCandidate(init: RTCIceCandidateInit): Promise<void> {
    if (!this.applied.add(candidateKey(init))) return; // duplicate
    const type = parseCandidateType(init.candidate);
    if (type) {
      this.patchState({ remoteCandidates: { ...this._state.remoteCandidates, [type]: this._state.remoteCandidates[type] + 1 } }, false);
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch (err) {
      // A single bad/obsolete candidate must never break the connection.
      if (!this.ignoreOffer) logIce.throttled('add-failed', 10_000, 'DEBUG', `${this.name}: addIceCandidate failed`, errorMessage(err));
    }
  }

  private sendCandidate(init: RTCIceCandidateInit): void {
    if (this.closed) return;
    this.opts.signal('ice-candidate', { candidate: init, pcId: this.pcId, targetPcId: this.remotePcId }, this.pcId);
  }

  // ── encodings ───────────────────────────────────────────────────────────

  private applyEncoding(kind: MediaKind): Promise<boolean | undefined> {
    return this.paramsQueue.run(async () => {
      const patch = this.desiredEncoding[kind];
      const sender = this.transceiverFor(kind)?.sender;
      // Before negotiation completes Chrome rejects setParameters ("modified RTCP parameters");
      // desired values are re-applied when the connection comes up.
      if (!patch || !sender || this.closed || !sender.transport || !this.pc.currentRemoteDescription) return false;
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      if (!params.encodings?.length) return false; // not negotiated yet – reapplied on connect
      const enc = params.encodings[0]! as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType; maxFramerate?: number };
      if (patch.maxBitrate === null) delete enc.maxBitrate;
      else if (patch.maxBitrate !== undefined) enc.maxBitrate = Math.round(patch.maxBitrate);
      if (patch.maxFramerate === null) delete enc.maxFramerate;
      else if (patch.maxFramerate !== undefined) enc.maxFramerate = patch.maxFramerate;
      if (patch.scaleResolutionDownBy !== undefined && kind === 'video') enc.scaleResolutionDownBy = Math.max(1, patch.scaleResolutionDownBy);
      if (patch.priority) enc.priority = patch.priority;
      if (patch.networkPriority) enc.networkPriority = patch.networkPriority;
      if (patch.degradationPreference && kind === 'video') params.degradationPreference = patch.degradationPreference;
      try {
        await sender.setParameters(params);
        return true;
      } catch (err) {
        logRtc.throttled(`setparams-${kind}`, 15_000, 'WARN', `${this.name}: setParameters(${kind}) failed`, errorMessage(err));
        return false;
      }
    });
  }

  private async reapplyEncodings(): Promise<void> {
    for (const kind of KINDS) if (this.desiredEncoding[kind]) await this.applyEncoding(kind);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private direction(): RTCRtpTransceiverDirection {
    if (this.opts.send && this.opts.receive) return 'sendrecv';
    if (this.opts.send) return 'sendonly';
    if (this.opts.receive) return 'recvonly';
    return 'inactive';
  }

  private transceiverFor(kind: MediaKind): RTCRtpTransceiver | undefined {
    return this.pc.getTransceivers().find((t) => t.currentDirection !== 'stopped' && t.receiver.track?.kind === kind);
  }

  private patchState(patch: Partial<PeerConnectionState>, emit = true): void {
    this._state = { ...this._state, ...patch };
    if (emit && !this.closed) this.events.emit('state', this._state);
    else if (emit && patch.connectionState === 'closed') this.events.emit('state', this._state);
  }
}
