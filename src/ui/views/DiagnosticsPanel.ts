import type { AppContext } from '../../app';
import { describeIceServers } from '../../config';
import { formatBitrate, formatBytes, formatMs, formatPct } from '../../core/format';
import { logHub, type LogEntry, type LogLevel } from '../../core/logger';
import type { PeerConnectionState } from '../../types/state';
import type { DataUsageSnapshot } from '../../webrtc/DataUsageMonitor';
import type { PeerStatsSnapshot, StatsReport } from '../../webrtc/StatsMonitor';
import { probeIceServers, type ProbeResult } from '../../webrtc/IceServerProbe';
import { h } from '../dom';
import { icons } from '../icons';

const LEVELS: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

/**
 * Advanced diagnostics. Everything about the network path is read from getStats()
 * (selected candidate pair → local/remote candidate types), never inferred from configuration.
 */
export class DiagnosticsPanel {
  readonly el: HTMLElement;
  private body = h('div', { class: 'diag-body' });
  private logList = h('ol', { class: 'log-list' });
  private report: StatsReport | null = null;
  private usage: DataUsageSnapshot | null = null;
  private logLevel: LogLevel = 'INFO';
  private pending = false;
  private probe: ProbeResult[] | 'running' | null = null;

  constructor(
    private readonly app: AppContext,
    onClose: () => void,
  ) {
    const levelSel = h('select', { 'aria-label': 'Log level filter' }, ...LEVELS.map((l) => h('option', { value: l, selected: l === this.logLevel }, l)));
    levelSel.addEventListener('change', () => {
      this.logLevel = levelSel.value as LogLevel;
      logHub.setLevel(this.logLevel === 'DEBUG' ? 'DEBUG' : logHub.level);
      this.renderLogs();
    });
    this.el = h(
      'aside',
      { class: 'diagnostics', 'aria-label': 'Connection diagnostics' },
      h(
        'header',
        { class: 'diag-header' },
        h('h2', {}, 'Diagnostics'),
        h('button', { class: 'btn small', onclick: () => void this.copy() }, 'Copy JSON'),
        h('button', { class: 'icon-btn', 'aria-label': 'Close diagnostics', html: icons.close, onclick: onClose }),
      ),
      this.body,
      h('section', { class: 'diag-section' }, h('div', { class: 'diag-row-head' }, h('h3', {}, 'Log'), levelSel), this.logList),
    );
    logHub.subscribe(() => this.scheduleLogs());
  }

  onStats(report: StatsReport, usage: DataUsageSnapshot): void {
    this.report = report;
    this.usage = usage;
    this.render();
  }

  render(): void {
    if (!this.el.isConnected) return;
    const { signaling, network, config, settings, identity, calls } = this.app;
    const net = network.info;
    const call = calls.state;
    const sections: HTMLElement[] = [];

    sections.push(
      this.section('Signaling & network', [
        ['Signaling', signaling.status],
        ['Channel', config.scaledroneChannelId],
        ['Device', identity.deviceId.slice(0, 8)],
        ['Session', identity.sessionId.slice(0, 8)],
        ['Browser online', net.online ? 'yes (hint only)' : 'no'],
        ['Link', [net.type, net.effectiveType, net.downlinkMbps ? `${net.downlinkMbps} Mbps` : '', net.rttMs ? `${net.rttMs} ms` : ''].filter(Boolean).join(' · ') || 'n/a'],
      ]),
    );

    sections.push(
      this.section('ICE configuration', [
        ['Servers', describeIceServers().join(', ')],
        ['TURN relay', config.hasTurn ? 'configured' : 'NOT configured'],
        ['Transport policy', settings.get().iceTestMode === 'relay-only' ? 'relay (TEST MODE)' : 'all'],
        ['Test mode', settings.get().iceTestMode],
        ['Fallback', `${this.app.webrtc.gateMode()} · P2P window ${config.ice.directP2PTimeoutMs} ms`],
      ]),
    );

    const probe = h('section', { class: 'diag-section' }, h('h3', {}, 'STUN / TURN health check'));
    if (this.probe === 'running') probe.append(h('p', { class: 'hint' }, 'Probing servers…'));
    else if (this.probe) {
      probe.append(
        h('dl', {}, ...this.probe.flatMap((r) => [h('dt', {}, `${r.ok ? '✅' : '❌'} ${r.kind.toUpperCase()}`), h('dd', {}, `${r.url}\n${r.ok ? `${r.candidates.join(', ')} in ${r.ms} ms` : r.errors.join('; ')}`)])),
      );
    }
    probe.append(h('button', { class: 'btn small', disabled: this.probe === 'running', onclick: () => void this.runProbe() }, 'Test STUN / TURN servers'));
    sections.push(probe);

    if (this.usage && call) {
      const u = this.usage;
      sections.push(
        this.section(`Data usage · ${u.scope}`, [
          ['My upload', `${formatBytes(u.uploadBytes)} · ${formatBitrate(u.uploadBps)}`],
          ...u.peers.map((p): [string, string] => [p.name, `recv ${formatBytes(p.receivedBytes)} · sent ${formatBytes(p.sentBytes)}`]),
          ['Total received', `${formatBytes(u.downloadBytes)} · ${formatBitrate(u.downloadBps)}`],
        ]),
      );
    }

    if (call) {
      const participants = [...call.participants.values()];
      if (!participants.length) sections.push(h('p', { class: 'hint' }, 'No peers yet.'));
      for (const p of participants) {
        if (!p.peer) {
          sections.push(this.section(`Peer: ${p.name}`, [['State', p.role === 'viewer' && call.role === 'viewer' ? 'not connected (viewer)' : 'waiting for negotiation']]));
          continue;
        }
        sections.push(this.peerSection(p.name, p.deviceId, p.peer, this.report?.peers.get(p.deviceId)));
      }
    } else {
      sections.push(h('p', { class: 'hint' }, 'Start or join a call to see per-peer diagnostics.'));
    }
    this.body.replaceChildren(...sections);
  }

  private peerSection(name: string, id: string, s: PeerConnectionState, st: PeerStatsSnapshot | undefined): HTMLElement {
    const path = s.selectedPath;
    const lc = s.localCandidates;
    const rc = s.remoteCandidates;
    const rows: Array<[string, string]> = [
      ['Connection State', s.connectionState],
      ['ICE State', s.iceConnectionState],
      ['Signaling State', s.signalingState],
      ['Gathering', s.iceGatheringState],
      ['Role', `${s.polite ? 'polite' : 'impolite'} · connection #${s.generation + 1}`],
      ['Connection Type', path ? path.connectionType : '— (no selected pair yet)'],
      ['Candidate Pair', path?.pairLabel ?? '—'],
      ['Transport', path ? `${path.transport}${path.relayProtocol ? ` (to TURN: ${path.relayProtocol})` : ''}` : '—'],
      ['Path', path?.pathLabel ?? '—'],
      ['Local ↔ Remote', path ? `${path.localAddress ?? '?'} ↔ ${path.remoteAddress ?? '?'}` : '—'],
      ['Relay fallback', s.gate],
      ['Candidates local', `host ${lc.host} · srflx ${lc.srflx} · relay ${lc.relay}`],
      ['Candidates remote', `host ${rc.host} · srflx ${rc.srflx} · prflx ${rc.prflx} · relay ${rc.relay}`],
      ['Time to connect', formatMs(s.timeToConnectMs)],
      ['ICE restarts / recoveries', `${s.iceRestarts} / ${s.reconnectAttempts}`],
    ];
    if (st) {
      rows.push(
        ['Quality', st.quality],
        ['RTT', formatMs(st.smoothedRttMs ?? st.rttMs)],
        ['Packet Loss', `${formatPct(st.lossPct)} in · ${formatPct(st.outboundLossPct)} out`],
        ['Jitter', formatMs(st.jitterMs)],
        ['Upload', formatBitrate(st.sendBitrate)],
        ['Download', formatBitrate(st.recvBitrate)],
        ['Available out / in', `${formatBitrate(st.availableOutgoingBitrate)} / ${formatBitrate(st.availableIncomingBitrate)}`],
        ['Audio', `${st.audio.codec ?? '—'} · ↑${formatBitrate(st.audio.sendBitrate)} ↓${formatBitrate(st.audio.recvBitrate)}`],
        [
          'Video',
          `${st.video.codec ?? '—'} · ↑${st.video.sendWidth ? `${st.video.sendWidth}×${st.video.sendHeight}@${Math.round(st.video.sendFps ?? 0)}` : '—'} ↓${st.video.recvWidth ? `${st.video.recvWidth}×${st.video.recvHeight}@${Math.round(st.video.recvFps ?? 0)}` : '—'}`,
        ],
        ['Limitation', st.video.qualityLimitationReason ?? '—'],
        ['Frames dropped / pkts discarded', `${st.video.framesDropped} / ${st.packetsDiscarded}`],
      );
    }
    if (s.iceErrors.length) rows.push(['ICE errors', s.iceErrors.join('\n')]);
    if (s.lastError) rows.push(['Last error', s.lastError]);
    const sec = this.section(`Peer: ${name}`, rows, path?.connectionType);
    sec.append(h('button', { class: 'btn small', onclick: () => this.app.calls.retryDirect(id) }, 'Retry direct P2P (ICE restart)'));
    return sec;
  }

  private section(title: string, rows: Array<[string, string]>, badge?: string): HTMLElement {
    return h(
      'section',
      { class: 'diag-section' },
      h('h3', {}, title, badge ? h('span', { class: 'path-badge', 'data-type': badge }, badge) : null),
      h('dl', {}, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    );
  }

  private async runProbe(): Promise<void> {
    this.probe = 'running';
    this.render();
    this.probe = await probeIceServers(this.app.config.iceServers);
    this.render();
  }

  private scheduleLogs(): void {
    if (this.pending || !this.el.isConnected) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.renderLogs();
    });
  }

  private renderLogs(): void {
    const max = LEVELS.indexOf(this.logLevel);
    const entries = logHub.buffer.filter((e) => LEVELS.indexOf(e.level) <= max).slice(-80);
    this.logList.replaceChildren(...entries.map((e: LogEntry) => h('li', { 'data-level': e.level }, `${new Date(e.ts).toLocaleTimeString()} [${e.scope}] ${e.message}`)));
    this.logList.scrollTop = this.logList.scrollHeight;
  }

  private async copy(): Promise<void> {
    const json = JSON.stringify(collectDiagnostics(this.app), null, 2);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      console.info(json);
    }
  }
}

/** Plain-object diagnostics (also exposed as window.__voip.diagnostics()). */
export function collectDiagnostics(app: AppContext) {
  const call = app.calls.state;
  const report = app.calls.session?.statsReport;
  return {
    signaling: app.signaling.status,
    iceServers: describeIceServers(),
    iceTestMode: app.settings.get().iceTestMode,
    call: call && {
      callId: call.callId,
      kind: call.kind,
      status: call.status,
      role: call.role,
      peers: [...call.participants.values()].map((p) => {
        const st = report?.peers.get(p.deviceId);
        return {
          peer: p.name,
          deviceId: p.deviceId,
          connectionState: p.peer?.connectionState,
          iceConnectionState: p.peer?.iceConnectionState,
          selectedCandidate: p.peer?.selectedPath?.pairLabel,
          connectionType: p.peer?.selectedPath?.connectionType,
          path: p.peer?.selectedPath?.pathLabel,
          transport: p.peer?.selectedPath?.transport,
          relayProtocol: p.peer?.selectedPath?.relayProtocol,
          gate: p.peer?.gate,
          localCandidates: p.peer?.localCandidates,
          remoteCandidates: p.peer?.remoteCandidates,
          iceRestarts: p.peer?.iceRestarts,
          generation: p.peer?.generation,
          pcId: p.peer?.pcId,
          rttMs: st?.smoothedRttMs,
          lossPct: st?.lossPct,
          bytesSent: st?.bytesSent,
          bytesReceived: st?.bytesReceived,
          quality: st?.quality,
        };
      }),
    },
  };
}
