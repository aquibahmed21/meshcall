# How the WebRTC layer works

This document explains, flow by flow, what the code does. For each flow it covers:

- who sends what, and when
- which state changes
- what happens if a message is **late**, **duplicated** or **lost**
- what happens if a **peer disconnects** or the **network changes**
- what happens when **direct P2P fails**, and when STUN and TURN come into play

File references point into `src/`.

---

## 1. How a 1:1 call is established

| Step | Sender → receiver | Message / action | State change |
|---|---|---|---|
| 1 | Caller | acquires the microphone and camera (`MediaManager.acquire`) | caller: Idle → **Calling** |
| 2 | Caller → `inbox-<callee>` | `call-invite {callKind: direct, media, expiresAt}` (plus Web Push if the callee is not online) | — |
| 3 | Callee → caller | `call-ringing` | callee: **Ringing** (modal, ringtone, system notification if hidden); caller: Calling → **Ringing** |
| 4 | Callee → caller | `call-accept` (after the callee's own media is acquired) | callee: **Connecting** |
| 5 | Caller → callee inbox | `call-cancel {answered-elsewhere}` | the callee's other tabs stop ringing; caller: **Connecting** |
| 6 | Both | subscribe to `mesh-<callId>` and broadcast `mesh-join`; the other replies `mesh-welcome` | participant recorded |
| 7 | Impolite side | creates an `RTCPeerConnection`, adds audio and video transceivers, `negotiationneeded` fires, and it sends an `offer` | peer: new → connecting |
| 8 | Polite side | creates a session on receiving the offer, runs `setRemoteDescription`, binds its tracks, sends an `answer` | — |
| 9 | Both | trickle `ice-candidate`s (see §2–4) | ICE checking |
| 10 | Both | `connectionState = connected` | call: **Connected** |

**Hangup:** `call-hangup` goes to the remote, followed by `mesh-leave`. Then `teardown()` runs: it closes the peer connections, stops the tracks, clears the timers and unsubscribes from the rooms.

**Late messages:**
- An invite that arrives after `expiresAt` (with a 60 s allowance for clock skew) is ignored.
- A `call-accept` for a call the caller no longer has gets a `call-hangup {ended}` reply, and the callee shows "That call is no longer available".
- A `call-ringing` or `call-accept` that arrives when the status has already moved on is ignored.

**Duplicate messages:**
- Every message is de-duplicated by `messageId` in `SignalingService`.
- A re-sent invite for a call that is already ringing just re-acks with `call-ringing`.
- A duplicate accept is ignored because the status is no longer Calling or Ringing.

**Lost messages:**
- The callee re-sends `call-accept` every 3 s, up to 5 times, until the caller appears in the mesh.
- The caller re-sends the invite when the callee comes online.
- Lost SDP is covered by the offer watchdog (§12).

**If the peer disconnects:** the call goes to **Reconnecting**, and recovery runs (§11–12). If there is no success within 45 s, the call becomes **Failed** ("Connection lost").

**Unreachable callee:** if the callee is offline and push is unavailable, there is no `call-ringing` within 8 s and the call fails with "appears to be offline".

**Timeouts:** the call rings for up to 45 s, then shows "No answer". The accept → connected phase has 25 s before the call becomes **Failed**. No state can spin forever.

## 2. How direct P2P is attempted first

`WebRTCManager.buildConfiguration()` uses `iceTransportPolicy: "all"`, all STUN and TURN servers, `bundlePolicy: "max-bundle"` and `iceCandidatePoolSize: 2`.

As soon as `setLocalDescription` runs, the browser gathers **host** candidates (local interfaces) instantly. `PeerSession` sends them to the remote peer right away. The remote pairs them with its own host candidates, and ICE connectivity checks start in priority order. **Host↔host pairs have the highest priority**, so on the same LAN they are checked first and win.

Relay candidates are held back by the `CandidateGate` for `DIRECT_P2P_TIMEOUT_MS`, as described in §4. This gives direct pairs a window in which the remote peer cannot even form relayed pairs toward us.

## 3. How STUN is used

The browser sends a STUN Binding request to each STUN server: `dev.aahlaad.in:3401`, then `stun.l.google.com` and `stun1`. The response reveals our public IP and port as the NAT sees them. That address becomes a **server-reflexive (srflx)** candidate, and it is trickled immediately (`HOST_ONLY_WINDOW_MS = 0`).

When two peers are on different networks, a working pair usually involves srflx on one or both sides. Media then flows **directly between the NATs**. The STUN server was only used to discover the address; **no media passes through it**.

Peer-reflexive (**prflx**) candidates appear during connectivity checks. They are classified as STUN unless both addresses are private, which indicates a LAN path behind mDNS.

## 4. How TURN is used as fallback

The browser also allocates a relay address on the TURN server, `turn:dev.aahlaad.in:3401` with long-term credentials. That address becomes a **relay** candidate. `CandidateGate.offer()` holds relay candidates and releases them when one of the following happens:

| Release trigger | Why |
|---|---|
| ICE or peer connection reaches `connected` | A direct path exists. Relay is sent as a *standby* fallback; its priority is lowest, so it is not selected while the direct pair works. |
| `DIRECT_P2P_TIMEOUT_MS` elapsed | Direct connectivity did not succeed in the window, so the fallback becomes available. |
| ICE `disconnected` or `failed` | The direct path is broken, so fall back now. |
| gathering complete with only relay candidates | Waiting would be pointless. |

After release, the remote agent pairs its candidates with our relay candidates. If nothing direct works, a relay pair succeeds and is selected: media flows **via the TURN server**.

Three rules keep TURN a genuine fallback:

- The gate never closes or restarts anything. It only controls when candidates are sent.
- The TURN allocation happens in parallel, so falling back costs no extra round trips.
- **Nothing remembers that TURN was needed.** The next connection starts over.

**Test modes** in Settings force `relay` or remove TURN. They are for diagnostics only and reset on reload.

## 5. How ICE chooses candidates

Each agent pairs every local candidate with every remote candidate of the same component. Pair priority is derived from the two candidates' priorities, which are dominated by the type preference: host 126 > prflx 110 > srflx 100 > relay 0.

The *controlling* agent is the offerer. It runs connectivity checks in priority order and **nominates** a succeeded pair. Chrome then switches to a better pair if one succeeds later (renomination). So even if a relay pair happens to succeed first, a direct pair that succeeds afterwards is preferred.

The gate strengthens this ordering. The browser's priorities are left unmodified.

## 6. How the selected candidate pair is detected

`StatsMonitor` calls `pc.getStats()` every 2 s, and `StatsParser.parseStats()` reads the result:

1. Read `transport.selectedCandidatePairId`, then the matching `candidate-pair`.
   - Fallbacks: `candidate-pair.selected === true` (Firefox), or `nominated && state === 'succeeded'`.
2. From that pair, read `local-candidate` and `remote-candidate`: `candidateType`, `protocol`, `relayProtocol`, `address`, `url`.
3. `classifyPath()` produces the result:
   - `relay` on either side → **TURN**
   - `host → host` → **P2P**
   - `srflx`/`prflx` involved → **STUN** (direct media through NAT)

The result is stored on the `PeerSession`. The ICE log line `Selected candidate pair = host → host` is written only when the pair changes. The result is displayed on the tile badge and in Diagnostics, and returned by `window.__voip.diagnostics()`. It is **never guessed from configuration**.

## 7. How group mesh calling works

A group call is a `MeshSession` with `kind: 'group'`. Each member holds one `PeerSession` per other member, managed by `PeerConnectionManager`. Membership is tracked through `mesh-join`, `mesh-welcome`, a heartbeat every 10 s, and `mesh-leave`.

Each heartbeat carries `peers: {remoteId: pcId}`. A receiver can therefore detect an **orphaned** connection: one it thinks exists but the other side does not know about. The impolite side then rebuilds that one link.

Local track changes (mute, camera, device, screen) are applied to every peer with `replaceTrack`. Quality is applied per peer with `setParameters`.

## 8. What happens when a participant joins

1. The joiner subscribes to `mesh-<callId>`. On room open, it broadcasts `mesh-join {role, media, peers}`.
2. Every member records the joiner, replies `mesh-welcome`, and, **if impolite** towards the joiner, immediately creates a fresh `RTCPeerConnection` and sends an offer.
3. The joiner learns about every member from their welcomes. For each member it is impolite towards, it creates the connection and sends the offer.
4. Each pair therefore has exactly one initial offerer, so there is no glare.
5. Every new connection gets its own P2P window (§2–4).

**Late or missed join:** the next heartbeat from either side reveals the missing session, and the impolite side creates it.

**Duplicate join:** if the session is unchanged and the connection is healthy, the member gets an ICE restart (its network may have changed). Otherwise nothing happens, and young connections are left alone.

## 9. What happens when a participant rejoins

This could be a reload, a new tab, or "Rejoin" after a crash:

1. The rejoiner has a **new `sessionId`**. Each member sees `mesh-join` with a different session, so it closes the old `PeerSession`, marks its remote `pcId` as **retired**, and keeps the participant's tile and `MediaStream` so the UI doesn't flicker.
2. A brand-new `RTCPeerConnection` is created by the impolite side. It gets new DTLS, new ICE credentials, and a new, re-armed P2P window.
3. Any late SDP or ICE from the old connection is dropped, because its `pcId` is retired or its `targetPcId` no longer matches.
4. Only links involving the rejoiner are touched. **Everyone else's connections keep running.**

If the rejoiner kept its session (only its signaling reconnected), the link gets an **ICE restart** instead.

## 10. Why every rejoin gets a fresh P2P opportunity

- The previous path may no longer exist. The participant may have a new IP, a new NAT mapping, or a different network altogether.
- Reusing an old `RTCPeerConnection` whose remote side was destroyed is impossible anyway, because DTLS fingerprints and ICE credentials changed.
- Caching "this peer needs TURN" would permanently degrade users who moved to a better network.

So every fresh connection or ICE generation re-arms the gate and starts again at host → srflx → relay. Nothing about the path is persisted.

The e2e suite verifies this three ways: a rejoin shows `generation 0 → 1, host → host`, a network change stays P2P after an ICE restart, and the call after a TURN call goes direct again.

## 11. How network changes trigger recovery

`NetworkMonitor` emits a (coalesced) event for any of these:

- `online` / `offline`
- a Network Information API `type` or `effectiveType` change
- **wake**: a timer gap of more than 15 s, meaning the device slept
- **resume**: the tab was hidden for more than 30 s, or restored from the bfcache

`CallManager` forwards the event to the active `MeshSession`, and from there to `ConnectionRecoveryManager.onNetworkChange()`:

- **offline:** recovery is paused. Attempts are not consumed; peers are marked as waiting for the network.
- **online / connection-change / wake:** ICE restart on **every** negotiated peer, including healthy-looking ones. Their path may be stale, and direct P2P should get a new chance.
- **resume:** only unhealthy peers are restarted.

Independently, the signaling liveness watchdog re-creates the ScaleDrone socket if its own publishes stop echoing. After signaling reconnects, the mesh is re-announced and unhealthy peers are restarted.

`navigator.onLine` is only ever a trigger, never evidence of connectivity.

## 12. How ICE restart works

1. `PeerSession.restartIce()` calls `pc.restartIce()`, with a fallback to `createOffer({iceRestart: true})`.
2. `negotiationneeded` fires, either immediately or once the signaling state returns to stable. The offer carries **new ICE ufrag/pwd**.
3. `setLocalDescription` sees a new local ufrag, so it counts a new ICE generation and **re-arms the CandidateGate**. Host candidates are sent first again, and relay is held for the window.
4. The remote detects the new remote ufrag, answers, and gathers anew. Its gate re-arms too.
5. Candidates tagged with a future ufrag that arrive before the restart offer are queued, not dropped.
6. The old pair keeps carrying media until a new pair is selected (make-before-break).

**Escalation** in `ConnectionRecoveryManager`:

- `disconnected` → wait 3 s → restart
- `failed` → restart now
- each unsuccessful restart times out after 10 s, 20 s, 30 s and is followed by the next restart
- more than 3 restarts → **re-create the `RTCPeerConnection`**; the polite side waits one extra interval, and a circuit breaker caps re-creation at 4 per minute
- an offer with no answer is re-sent twice, then treated as "stalled", which leads to re-creation

**Simultaneous restarts** from both sides are resolved by Perfect Negotiation (§13).

## 13. How Perfect Negotiation prevents race conditions

`PeerSession.handleDescription()`:

```
collision = offer arrived && (makingOffer || (signalingState != stable && !settingRemoteAnswerPending))
ignoreOffer = !polite && collision
impolite + collision → ignore the remote offer (our offer wins)
polite + collision   → setRemoteDescription(offer) performs an implicit rollback of our offer, then answer
answer while not in have-local-offer → stale/duplicate → ignored
```

- **Roles** are deterministic and symmetric: `"${deviceId}|${sessionId}"` is compared on both sides.
- **All SDP and ICE** for a peer runs through a `SerialQueue`, so a candidate is never applied while `setRemoteDescription` is in flight.
- **When both sides re-create at once:**
  - Both fresh sessions offer.
  - The polite side accepts the impolite side's offer, rolling back its own.
  - The impolite side ignores the polite side's offer.
  - Candidates that belonged to the ignored offer are parked, then applied or harmlessly rejected once the answer arrives.
  - Result: one connection, no deadlock.
- **Joins during negotiation** create an independent link and don't affect other peers' negotiations.
- **Arbitrary delays are never used** to avoid races. The only timers are protocol timeouts: grace periods, watchdogs and the P2P window.

## 14. How offline push notifications work

1. **Callee opts in:**
   - `pushManager.subscribe({userVisibleOnly: true, applicationServerKey: VAPID})`
   - `POST /subscribe {deviceId, subscription}` to the relay, `server/push-server.mjs`
2. **Caller:** when the callee is not online, or does not ack within 8 s, the caller sends `POST /notify {toDeviceId, invite}`. The relay signs a VAPID Web Push (TTL 60 s, urgency high).
3. **Callee's Service Worker (`public/sw.js`):** on `push`, if a window is already visible it does nothing, because that page rings via signaling. Otherwise it shows **"Incoming Video Call — John is calling you [Answer] [Dismiss]"**.
4. **Click:**
   - If a window exists, the SW focuses it and posts `{action, callId}`.
   - Otherwise it opens `/?action=answer&callId=…`.
   - **Dismiss** is forwarded to open windows as a reject.
5. **App starts:** it connects signaling and the callee shows as online. The caller sees the transition and **re-sends `call-invite`**. The app, remembering `pendingAutoAnswer`, accepts automatically. Normal WebRTC negotiation follows.

**Limitation:** the Service Worker never holds media. If the caller hung up in the meantime, the app shows "That call is no longer available".

## 15. How bandwidth and data usage are calculated

For each peer, each tick (2 s), exactly one `pc.getStats()` report is read:

- **Wire bytes** come from `transport.bytesSent` and `bytesReceived`, falling back to the sum of candidate-pair bytes where transport stats are missing (Firefox). The app never adds RTP bytes on top, so nothing is double-counted.
- **Bitrates** are Δbytes × 8 / Δt, computed from the previous sample *of the same `pcId`*.
- **`DataUsageMonitor`** accumulates positive deltas per peer. When the `pcId` changes (re-creation), the baseline resets to 0, so totals continue without a jump or a double count.
- **Displayed values:**
  - My Upload = Σ sent to all peers (a mesh uploads separately to each)
  - per-peer received
  - total received
  - live upload and download bitrate
- **Scope:** "Current Call", reset at call start.

## 16. How weak networks are detected and handled

**Detection:**

- RTT: `candidate-pair.currentRoundTripTime`, or `remote-inbound-rtp.roundTripTime`
- inbound loss: ΔpacketsLost / (Δlost + Δreceived)
- outbound loss: `remote-inbound-rtp.fractionLost`
- jitter: `inbound-rtp.jitter`
- a **stall**: transport bytes not increasing for 3 samples while "connected"

RTT and loss are EWMA-smoothed and classified as Excellent, Good, Poor or Critical.

**Handling:**

- **"Auto" video:** each peer runs its own `AdaptiveLadder` (180p → 360p → 480p → 720p).
  - Steps down after 2 bad samples; Critical drops two steps. Low `availableOutgoingBitrate` also counts as bad.
  - Steps up only after 5 good samples, 8 s at the current level, 1.3× headroom for the next level, and an up-cooldown that doubles on oscillation.
  - Changes use `setParameters` (`maxBitrate`, `scaleResolutionDownBy`, `maxFramerate`), with no renegotiation.
- **Audio** keeps high sender priority and a fixed low bitrate, so speech survives while video degrades.
- **Critical stall / dead path:** ICE eventually reports `disconnected` or `failed`, and recovery takes over (§12).
- **UI:** the network pill shows the worst peer's quality, each tile shows a quality dot, and Diagnostics has the full numbers.
