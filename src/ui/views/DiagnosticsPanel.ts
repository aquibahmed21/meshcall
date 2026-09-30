import type { AppContext } from '../../app';
import { describeIceServers } from '../../config';
import { formatBitrate, formatBytes, formatMs, formatPct } from '../../core/format';
import { logHub, type LogEntry, type LogLevel } from '../../core/logger';
import type { PeerConnectionState } from '../../types/state';
import type { DataUsageSnapshot } from '../../webrtc/DataUsageMonitor';
import type { PeerStatsSnapshot, StatsReport } from '../../webrtc/StatsMonitor';
import { listIceServers, testIceServer, type IceServerEntry, type IceServerTestResult } from '../../webrtc/IceServerProbe';
import { netRows, peerNetInfo } from '../netInfo';
import { PUSH_STATUS_LABEL, type PushDiagnostics } from '../../services/PushNotificationService';
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
  /** url → latest test result (per-server state; 'testing' while running). */
  private iceTests = new Map<string, IceServerTestResult>();
  private pushDiag: PushDiagnostics | null = null;
  private pushDiagKey = '';

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

    sections.push(this.pushSection());

    if (call) sections.push(this.networkSummary());
    sections.push(this.iceTestSection());

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

  /** Push diagnostics (endpoint redacted; subscription keys are never shown). */
  private pushSection(): HTMLElement {
    void this.app.push.diagnostics().then((d) => {
      const key = JSON.stringify(d);
      if (key !== this.pushDiagKey) {
        this.pushDiagKey = key;
        this.pushDiag = d;
        this.render();
      }
    });
    const d = this.pushDiag;
    const yes = (b: boolean) => (b ? 'Yes' : 'No');
    const rows: Array<[string, string]> = d
      ? [
          ['Browser Support', yes(d.browserSupport)],
          ['Notification Permission', d.permission],
          ['Service Worker', d.serviceWorker],
          ['Status', PUSH_STATUS_LABEL[d.status]],
          ['Push Subscription', d.subscription === 'active' ? `Active${d.serverVerified === true ? ' (server confirmed)' : d.serverVerified === false ? ' (NOT on server)' : ''}` : 'None'],
          ['Endpoint', d.endpoint ?? '—'],
          ['Push Server', d.pushServer],
          ['Last Registration', d.lastRegistration ? new Date(d.lastRegistration).toLocaleString() : '—'],
          ['Targeted delivery', d.targetedDelivery ? 'Supported' : 'Not supported by the push server (broadcast only) – closed apps cannot be woken for a call'],
        ]
      : [['Status', 'Loading…']];
    if (d?.lastError) rows.push(['Last error', d.lastError]);
    return this.section('Push Notifications', rows);
  }

  /** "Network Diagnostics": how every participant is connected right now (from getStats). */
  private networkSummary(): HTMLElement {
    const call = this.app.calls.state!;
    const el = h('section', { class: 'diag-section net-summary' }, h('h3', {}, 'Network Diagnostics'));
    const people = [...call.participants.values()].filter((p) => p.peer || call.role !== 'viewer');
    if (!people.length) el.append(h('p', { class: 'hint' }, 'No peer connections yet.'));
    for (const p of people) {
      const info = peerNetInfo(p, this.report?.peers.get(p.deviceId));
      el.append(
        h(
          'div',
          { class: `net-card ${info.status}`, 'data-peer': p.deviceId, 'data-path': info.path },
          h('div', { class: 'net-card-head' }, h('strong', {}, p.name), h('span', { class: 'path-badge', 'data-type': info.pathLabel }, info.pathLabel)),
          h('dl', {}, ...netRows(info).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        ),
      );
    }
    return el;
  }

  /** "Network / ICE Diagnostics": test each configured STUN / TURN URL independently. */
  private iceTestSection(): HTMLElement {
    const entries = listIceServers(this.app.config.iceServers);
    const group = (type: 'stun' | 'turn', title: string) => {
      const list = entries.filter((e) => e.type === type);
      const busy = list.some((e) => this.iceTests.get(e.url)?.status === 'testing');
      return h(
        'div',
        { class: 'ice-group', 'data-type': type },
        h(
          'div',
          { class: 'diag-row-head' },
          h('h4', {}, title),
          list.length ? h('button', { class: 'btn small', disabled: busy, onclick: () => void Promise.all(list.map((e) => this.runIceTest(e))) }, `Test all ${type.toUpperCase()}`) : null,
        ),
        list.length ? h('ul', { class: 'ice-tests' }, ...list.map((e) => this.iceTestRow(e))) : h('p', { class: 'hint' }, `No ${type.toUpperCase()} server configured.`),
      );
    };
    return h(
      'section',
      { class: 'diag-section ice-diag' },
      h('h3', {}, 'Network / ICE Diagnostics'),
      h('p', { class: 'hint' }, 'Each server is tested alone with a temporary connection. TURN tests force relay-only gathering (calls keep using "all").'),
      group('stun', 'STUN Tests'),
      group('turn', 'TURN Tests'),
    );
  }

  private iceTestRow(e: IceServerEntry): HTMLElement {
    const r = this.iceTests.get(e.url);
    const status = r?.status;
    const icon = status === 'success' ? '✓' : status === 'failed' ? '✕' : status === 'testing' ? '…' : '○';
    const lines: string[] = [];
    if (status === 'testing') lines.push('Testing…');
    else if (status === 'success' && e.type === 'stun') lines.push('Reachable', 'srflx candidate discovered', `Public address: ${r!.address ?? 'n/a'}`, `${r!.durationMs} ms`);
    else if (status === 'success') lines.push('TURN working', 'relay candidate discovered', `Relay address: ${r!.address ?? 'n/a'}`, `Protocol: ${r!.relayProtocol ?? r!.protocol ?? 'n/a'}`, `${r!.durationMs} ms`);
    else if (status === 'failed') lines.push(r!.error ?? 'Failed', ...(r!.causes?.length ? ['Possible causes:', ...r!.causes.map((c) => `- ${c}`)] : []), ...(r!.errors.length ? [`Errors: ${r!.errors.join('; ')}`] : []));
    else lines.push('Not tested yet');
    return h(
      'li',
      { class: `ice-test ${status ?? 'idle'}`, 'data-url': e.url },
      h('div', { class: 'ice-test-head' }, h('span', { class: 'ice-icon' }, icon), h('code', { class: 'grow' }, e.url), h('button', { class: 'btn small', disabled: status === 'testing', onclick: () => void this.runIceTest(e) }, e.type === 'turn' ? 'Test TURN' : 'Test')),
      h('div', { class: 'ice-test-body' }, lines.join('\n')),
    );
  }

  private async runIceTest(e: IceServerEntry): Promise<void> {
    if (this.iceTests.get(e.url)?.status === 'testing') return;
    this.iceTests.set(e.url, { url: e.url, type: e.type, status: 'testing', errors: [], testedAt: Date.now(), durationMs: 0 });
    this.render();
    this.iceTests.set(e.url, await testIceServer(e));
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
          connectionPath: p.peer?.connectionState === 'connected' ? (p.peer?.selectedPath?.connectionPath ?? 'unknown') : 'unknown',
          server: p.peer?.selectedPath?.server,
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
