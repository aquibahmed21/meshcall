import { createLogger } from '../core/logger';
import type { AppConfig } from '../config';
import type { SettingsService } from '../services/SettingsService';

const log = createLogger('WebRTC');

/**
 * Factory for RTCPeerConnections with the P2P-first configuration:
 *   iceTransportPolicy "all"  – gather host + srflx + relay; ICE priorities prefer direct paths
 *   bundlePolicy "max-bundle" – one transport per peer (one ICE negotiation, clean stats)
 *   iceCandidatePoolSize      – pre-gather so candidates are ready when negotiation starts
 * Relay-only / no-relay are explicit diagnostic test modes, never the default.
 */
export class WebRTCManager {
  constructor(
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
  ) {}

  static isSupported(): boolean {
    return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  buildConfiguration(): RTCConfiguration {
    const mode = this.settings.get().iceTestMode;
    let iceServers = this.config.iceServers;
    if (mode === 'no-relay') {
      iceServers = iceServers
        .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/^turns?:/i.test(u)) }))
        .filter((s) => s.urls.length > 0);
    }
    if (mode !== 'normal') log.warn(`ICE TEST MODE "${mode}" active – not the production connection flow`);
    return {
      iceServers,
      iceTransportPolicy: mode === 'relay-only' ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: this.config.ice.candidatePoolSize,
    };
  }

  createPeerConnection(): RTCPeerConnection {
    return new RTCPeerConnection(this.buildConfiguration());
  }

  /** Gate mode: test modes disable gating so the forced path is exercised immediately. */
  gateMode(): 'gated' | 'native' {
    return this.settings.get().iceTestMode === 'normal' ? this.config.ice.fallbackMode : 'native';
  }
}
