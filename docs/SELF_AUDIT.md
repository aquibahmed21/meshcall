# Final self-audit

I audited the codebase against every category in the requirements, first by reading the code and then by running the automated suites against the real ScaleDrone channel:

- unit tests
- the two/three-browser e2e suite
- the resilience suite
- responsive screenshots

The e2e and resilience suites run headless Chrome with fake media.

Part A lists the defects that were **found and fixed**. Every one was confirmed by a failing test or a reproduction before it was fixed, and verified afterwards. Part B covers the checklist categories where no defect was found, with the mechanism that prevents each problem. Part C lists known limitations that remain.

---

## A. Issues found and fixed

### 1. Recovery storm: 1,000+ RTCPeerConnections created in seconds

- **Found by:** the resilience e2e (peer disappears mid-call). Chrome eventually threw `Cannot create so many PeerConnections`.
- **Root cause:** in `ConnectionRecoveryManager.restart()`, `session.setReconnectAttempts(n)` emits a state update *synchronously* before the restart timer was armed. The `failed` state re-entered `onPeerState` → `restart()` → `attempts++` → … about a thousand frames deep. As the stack unwound, every frame saw `attempts > max` and called `recreate()`.
- **Impact:** a single failed peer could exhaust the browser's PeerConnection limit. That broke the call, and the whole tab, for every participant.
- **Fix:**
  - Recovery now reacts only to real `connectionState` **transitions**; attribute-only updates are ignored.
  - A re-entrancy guard protects `restart()`.
  - The restart timer is armed *before* any side effect.
  - As defence in depth, a circuit breaker in `PeerConnectionManager` allows at most 4 re-creations per peer per minute.
  - A regression test (`tests/unit/recovery.test.ts`) uses a fake session that emits state synchronously, the same way the real one does.
- **Verified:** the resilience suite now reports "Ann created 2 RTCPeerConnections in total".

### 2. Infinite synchronous loop on "connected"

- **Found by:** the first e2e run (`Maximum call stack size exceeded`).
- **Root cause:** the same pattern as issue 1, on the success path. On `connected`, recovery called `setReconnectAttempts(0)`, which re-emitted `connected`, which called `setReconnectAttempts(0)` again, and so on.
- **Impact:** UI updates were lost and the call view stopped rendering correctly.
- **Fix:** `setReconnectAttempts` is now a no-op when the value is unchanged, and recovery only reacts to transitions (issue 1).

### 3. `setParameters` called before negotiation

- **Found by:** e2e logs (`InvalidModificationError: modified RTCP parameters`).
- **Root cause:** quality presets were applied as soon as a peer was created. Before negotiation, Chrome exposes default encodings but rejects `setParameters`.
- **Impact:** a warning on every call; the first quality application was lost.
- **Fix:** encodings are applied only once `sender.transport` and `currentRemoteDescription` exist. The desired values are stored and re-applied on `connected`.

### 4. A participant who left a group could not be re-invited

- **Found by:** e2e "group: participant rejoin".
- **Root cause:** invites were de-duplicated by `callId`, and an invite for a call whose "ended" screen was still visible counted as a duplicate.
- **Impact:** "Add participant" silently did nothing for anyone who had previously left.
- **Fix:** only *1:1* invites that were already handled are suppressed. Group re-invites are allowed, and a terminal call with the same id is reset.

### 5. Live viewers tracked other viewers

- **Found by:** e2e "live".
- **Root cause:** every `mesh-join` or heartbeat was recorded as a participant, even when the role pairing (viewer↔viewer) never connects.
- **Impact:**
  - Diagnostics showed phantom peers.
  - Viewers replied `mesh-welcome` to other viewers, which is wasted signaling.
  - Heartbeat orphan checks could misfire.
- **Fix:** `MeshSession.onMember` ignores members it should never connect to before doing anything else.

### 6. The caller re-sent the invite on every presence event

- **Found by:** log review.
- **Root cause:** the rule "the callee came online, so re-deliver the invite" was evaluated on *every* presence change, and heartbeats cause presence changes every 20 s.
- **Impact:** duplicate invites. The callee de-duplicated them, but it was still wasted traffic.
- **Fix:** the invite is re-sent only on an actual offline → online *transition* of the callee.

### 7. Media leak when a call ends during the permission prompt

- **Found by:** code audit.
- **Root cause:** `getUserMedia` resolving after the call had been cancelled (for example, the caller hung up while the prompt was still open) attached tracks to a call that no longer existed.
- **Impact:** the camera and microphone stayed on after the call ended.
- **Fix:** `MediaManager` keeps a generation counter that `release()` bumps. Any capture that resolves after a release is stopped immediately.

### 8. A lost `call-accept` left the caller ringing

- **Found by:** code audit.
- **Root cause:** accept was sent exactly once, over an unreliable pub/sub channel.
- **Impact:** the callee was stuck in "Connecting" until its 25 s timeout while the caller rang until its 45 s timeout.
- **Fix:** the callee re-sends `call-accept` every 3 s, up to 5 times, until the caller appears in the mesh. The caller ignores duplicate accepts.

### 9. Needless re-creation during initial negotiation

- **Found by:** code audit.
- **Root cause:** a repeated `mesh-join` from the same session (after its signaling reconnected) re-created a connection that was still in its first seconds of negotiation.
- **Impact:** churn and slower connection setup.
- **Fix:** connections younger than the negotiation timeout are left alone. Connected ones get an ICE restart instead.

### 10. Group size cap enforced only in the UI

- **Found by:** code audit.
- **Fix:** the host rejects joins beyond `maxParticipants` with `mesh-reject: full`.

### 11. Toast de-dupe map grew without bound

- **Found by:** code audit.
- **Fix:** entries are pruned after 10 s.

### 12. Tablet sidebar overflow

- **Found by:** screenshot review at 820 px width.
- **Fix:** the sidebar action buttons can now shrink.
- **Verified:** no horizontal overflow at 1440, 820 or 390 px.

---

## B. Checklist: no defect found, with the mechanism that prevents each

| Area | Mechanism |
|---|---|
| **Race conditions / offer collisions** | Perfect Negotiation (`makingOffer`, `ignoreOffer`, `isSettingRemoteAnswerPending`, implicit rollback). Deterministic roles. A per-peer `SerialQueue` for all inbound SDP and ICE. Only the impolite side makes the initial offer. |
| **Duplicate peer connections** | One `PeerSession` per remote device. The initial offer comes from the impolite side only. Replacing a session always closes and retires the old one first. |
| **Stale peer connections** | Every negotiation message carries `pcId` and `targetPcId`. Retired remote `pcId`s are dropped. A new remote session or `pcId` means a brand-new connection. |
| **Duplicate ICE candidates** | De-duplicated by (ufrag, mid, candidate). Messages are de-duplicated by `messageId`. |
| **Incorrect candidate handling** | Candidates are queued until their SDP arrives, including candidates for a future ICE generation. Orphans (arriving before the offer that creates their session) are parked for 30 s. `addIceCandidate` errors are caught per candidate. |
| **Failed ICE restart** | Restarts are escalated with growing timeouts, then the connection is re-created. The negotiation watchdog re-sends lost offers. Recovery pauses while offline. |
| **TURN forced unnecessarily** | `iceTransportPolicy: "all"` in the normal flow. Relay-only exists only as an explicitly labelled test mode that resets on reload. No SDP priority munging. |
| **P2P not retried after rejoin** | A new session triggers a new connection and a re-armed `CandidateGate`. Verified by e2e: "Rejoin tries direct P2P again — host → host". |
| **P2P not retried after network change** | The network, wake and online events trigger an ICE restart on every peer, which re-arms the gate. Verified by e2e with ICE restarts going 0 → 1 and the path staying P2P. |
| **"TURN required" cached** | Nothing about the path is persisted. Verified by e2e: "Next call after a TURN call goes direct again". |
| **Incorrect selected-candidate detection** | `transport.selectedCandidatePairId`, with fallbacks to `selected` and to nominated+succeeded. Unit-tested with Chrome-style and Firefox-style reports. The decoy (non-selected) pair is ignored. |
| **Memory leaks** | A `Disposer` per mesh session releases listeners and intervals. `PeerSession.close` nulls every handler. `StatsMonitor` and `DataUsageMonitor` drop state for gone peers. The call view clears its interval. |
| **Media leaks** | `teardown()` always calls `media.release()`. Screen-share tracks are stopped. Device swaps stop the old track. Verified by e2e: "Hangup releases camera/mic and peer connections on both sides". |
| **Duplicate media streams** | One remote `MediaStream` per participant. `ontrack` replaces any existing track of the same kind. A keyed tile grid never re-binds a video element to the same stream. |
| **Group participant bugs** | Leave closes only the leaver's connection (verified by e2e). Heartbeat reconciliation heals missed joins and orphaned one-sided connections. Silent participants are removed only if their media is also dead. |
| **Data usage double counting** | Transport bytes only, with per-`pcId` delta accumulation. Unit-tested across re-creation and duplicate samples. |
| **Notification limitations** | Documented. The Service Worker never claims to hold a call. Push needs a relay server and is disabled, with a UI message, when none is configured. |
| **Responsive layout** | Screenshots at desktop, tablet and phone sizes show no horizontal overflow. Safe-area insets are respected, touch targets are ≥ 44 px, and phones get a bottom navigation. |
| **Weak networks** | Hysteresis ladder with a doubling up-cooldown. Per-peer encodings. Audio gets high sender priority. Unit-tested for no oscillation. |

---

## C. Known limitations that remain

- **The configured dev TURN/STUN server was not usable from the test machine:**
  - `turn:dev.aahlaad.in:3401` and `stun:dev.aahlaad.in:3401` did not answer from the test network.
  - The same host answers STUN on port **3478**, but rejects the supplied TURN credentials there with `401 Unauthorized`.
  - The relay path was therefore verified against a local TURN server (`tests/e2e/local-turn.mjs`).
  - Use **Diagnostics → Test STUN / TURN servers** to check the server from your own network.
- **Offline emulation does not drop WebRTC's UDP traffic.** Browser offline emulation, via both CDP and Playwright, only cuts HTTP and WebSocket traffic. The automated offline test therefore proves the *event-driven* recovery path (the ICE restart on `online`), not recovery from a real media outage. Real outages were covered by the "peer vanishes" scenario and the recovery unit tests.
- **Real NAT and firewall fallback** (a direct attempt failing, then TURN) cannot be reproduced on a single host. The fallback logic is unit-tested in `CandidateGate`, and the relay path itself is verified by e2e.
- **No signaling authentication:** ScaleDrone is used without JWT, and the push relay has no authentication. Both are called out in the README as production requirements.
