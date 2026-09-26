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

---

## D. Audit of the chat, Picture-in-Picture and fullscreen features

These were verified with `npm test` (47 unit tests) and `npm run test:features` (45 browser checks), plus regression runs of `test:e2e` (20/20), `test:resilience` (7/7) and `test:screens` (no horizontal overflow at 1440, 820 or 390 px).

### Issues found and fixed

#### D1. PiP stayed open after the call ended

- **Found by:** the features e2e.
- **Root cause:** during teardown, `media.release()` triggers a render *before* the call status becomes terminal. With the remote tile already gone, the main participant switched to the local video, and PiP auto-follow started an *entering* transition. The terminal `exitAll()` then returned early because a transition was in flight. The follow then failed ("video element has no video track"), which left PiP on a detached remote `<video>` the controller no longer recognised.
- **Impact:** a stale PiP window stayed open showing a frozen frame after hangup.
- **Fix:**
  - `exitPip()` and `exitAll()` wait for any in-flight PiP request instead of bailing out.
  - The controller remembers every video it put into PiP (a `WeakSet`), so detached ones are still exited.
  - PiP only auto-follows tiles that really have video, and only while the call is active.

#### D2. Fullscreen spotlight squeezed the main video to 200 px

- **Found by:** screenshot review.
- **Root cause:** `justify-content: center` shrank the grid columns to the filmstrip width.
- **Fix:** full-width columns, with filmstrip tiles centred and width-capped inside their cells.

#### D3. The toolbar was rebuilt on every stats tick

- **Found by:** code audit.
- **Root cause:** the controls were recreated every 2 s.
- **Impact:** keyboard focus was lost, and a click could land between a button's removal and its recreation.
- **Fix:** the controls and panel tabs are rebuilt only when a signature of their visible state changes, and focus is restored afterwards.

#### D4. Toggle buttons looked like warnings

- **Found by:** screenshot review.
- **Root cause:** Chat, Fullscreen and PiP used the red "muted" style when active.
- **Fix:** they now use an accent style; red is kept for mute, camera off and similar states.

#### D5. The PiP follow was requested twice on each tile click

- **Found by:** code audit.
- **Root cause:** `select()` and `render()` both requested it.
- **Impact:** harmless, because concurrent enters were already guarded, but it did redundant work.
- **Fix:** only `render()` requests it. It still runs inside the click handler, so it keeps user activation.

### Checklist

| Check | Result / mechanism |
|---|---|
| **No duplicate event listeners** | `ChatService` attaches its signaling listeners once, in `start()`. `ViewModeController` uses one document-level listener per event; PiP events bubble, so there are no per-video listeners. All listeners are removed via `Disposer` when the call view is disposed. |
| **No memory leaks** | The call view disposes its interval, listeners, grid and view-mode controller. `ChatService.unbind()` clears messages, processed ids and delivery timers. |
| **No duplicate messages** | `processedMessageIds` plus signaling-level `messageId` de-duplication. The e2e injects duplicates, and verifies each real message renders exactly once. |
| **No duplicate chat subscriptions** | Chat uses the mesh-room subscription the call already has. It opens no room of its own. |
| **No stale `callId` messages** | Messages are ignored unless `callId === boundCallId`. The binding is cleared on call end; tested in unit and e2e. |
| **No broken WebRTC connections** | No WebRTC code changed. The only signaling changes are an additive `chat-message` type, an optional caller-chosen `messageId`, and an `echo` event. The e2e and resilience suites pass unchanged. |
| **No broken responsive layout / horizontal scrolling** | No overflow at 1440, 820 or 390 px, with or without the chat open. On a 390×430 "keyboard" viewport the input stays visible. |
| **No PiP or fullscreen state mismatch** | Button labels come from `document.pictureInPictureElement` and `document.fullscreenElement` on every browser event. Tested for closing the window, ESC/exit, Fullscreen → PiP, PiP → Fullscreen, and call end. |
| **No controls hidden on mobile** | Primary controls stay inline. PiP, Fullscreen, People, Invite and Stats are reachable through **More** (verified by e2e). |

### Remaining limitations

- **PiP availability:** Firefox has no PiP API and iPhone Safari has no element fullscreen, so those controls are hidden there. Auto-following a *new* main participant while PiP is open can be refused by a browser that requires user activation; PiP then keeps showing the previous video.
- **No chat history:** chat has no persistence or history for someone who joins or reloads later, by design (no backend). Ordering uses sender timestamps, so large clock skew between devices can reorder near-simultaneous messages.
- **Not automated in headless Chrome:** a real on-screen keyboard and native ESC handling in fullscreen. The keyboard was approximated by shrinking the viewport; the fullscreen test falls back to `exitFullscreen()` if ESC is not delivered.

---

## E. Audit of rooms, call layouts, 1:1 → group conversion and live-stream audience

Verification:

- `npm test`: 67 unit tests (room validation/keys, layout plans for 1/2/3/5+ participants, speaker hysteresis, …).
- `npm run test:rooms`: 60 browser checks.
- Regression runs of `test:e2e` (20/20), `test:features` (45/45) and `test:resilience` (7/7), plus `test:screens` (no overflow at desktop, tablet or phone).

### Issues found and fixed

#### E1. The rejoin banner never appeared after a reload

- **Found by:** e2e.
- **Root cause:** the UI is now created *after* `joinRoom()` resolves, so it missed the `rejoinAvailable` event that `CallManager.start()` had already emitted.
- **Impact:** a user who reloaded mid-call could not rejoin.
- **Fix:** the rejoin offer is kept as state (`calls.rejoinOffer`), which the UI reads whenever it attaches.

#### E2. A group call collapsed when two invitees joined at the same time

- **Found by:** e2e.
- **Root cause:** an invitee's join was only accepted if its inviter was already a *connected* participant of the receiving member. The receiver answered `mesh-reject`, and the joiner treated any reject as fatal.
- **Impact:** a whole group call could fail during a race.
- **Fix:**
  - A vouch now needs only that the inviter is on the allow-list.
  - In group and live calls, only the host's or streamer's reject is authoritative; others are logged, and the link heals on the next heartbeat.

#### E3. Live viewers rejected each other

- **Found by:** e2e.
- **Root cause:** after the access-policy refactor, the "should these roles connect at all?" check ran *after* the access check. A viewer therefore answered another viewer's join with `mesh-reject`, which killed that viewer's stream.
- **Impact:** only the first viewer of a stream could watch.
- **Fix:** non-connectable roles are ignored silently before any access check, and only the streamer's reject counts.

#### E4. A viewer who reloaded still showed as "Streaming"

- **Found by:** e2e.
- **Root cause:** nothing told the streamer that the viewer had gone, so the streamer waited for ICE to time out (tens of seconds).
- **Impact:** the upload slot was held and the audience status was wrong.
- **Fix:** viewers send `live-viewer-left` on page hide, and the streamer closes that connection immediately. Re-watching is always a fresh join.

#### E5. No active speaker when several people talk equally loud

- **Found by:** e2e with 5 people.
- **Root cause:** the selector required one specific id to lead for 900 ms. With equal speakers the lead changes every sample, so the timer kept resetting.
- **Impact:** the Speaker layout never picked anyone.
- **Fix:** while nobody holds the floor, sustained speech from anyone selects the loudest. The per-person hold still applies when switching away from an existing speaker. Unit-tested.

#### E6. The Everyone-mode audience listed offline and not-watching people as "Invited"

- **Found by:** screenshot review.
- **Fix:** only online room members are listed, and people who haven't joined show as *Can watch*.

#### E7. `addParticipants()` didn't enforce the mesh cap

- **Found by:** code audit (only the dialog did).
- **Fix:** over-cap requests are trimmed, with a message.

#### E8. Duplicate-looking streamer controls

- **Found by:** screenshot review.
- **Root cause:** a "Viewers" panel control and an "Audience" dialog control sat side by side.
- **Fix:** the dialog control is renamed **Manage**.

### Checklist

| Check | Result / mechanism |
|---|---|
| **Duplicate peer connections** | One `PeerSession` per remote device per call. A 1:1 → group conversion creates only the new links; the existing A↔B `pcId` is unchanged (e2e). |
| **Duplicate ScaleDrone subscriptions** | `start()` of presence, calls and live first disposes any previous state. In a room there are exactly two subscriptions (lobby + inbox), plus one mesh room per active call. After leaving there are zero (e2e). |
| **Cross-room signaling** | Separate ScaleDrone rooms per room, and a `roomId` filter on every incoming message. A forged invite with a foreign `roomId` published straight into a room inbox is dropped (e2e). |
| **Cross-call / cross-stream signaling** | `callId` checks in `CallManager`, `MeshSession` and `ChatService`. Participant-adds are accepted only from participants of that call; live-audience messages only from that stream's streamer. |
| **Stale room/call/stream state** | `leaveRoom()` ends the call (closing peer connections and media), clears presence users, streams, chat, pending invites and the rejoin offer, and drops the signaling scope and outbox. Known users are remembered per room. |
| **Participant duplication** | Participants are keyed by `deviceId`. Duplicate invites are skipped, and a re-join with a new session replaces the old one. |
| **Incorrect mesh connections** | Viewers never connect to each other. Group members connect to all others (5-person full mesh verified). |
| **P2P retry / unnecessary TURN** | Every new link — added participant, rejoin, added viewer, viewer reconnect — is a fresh `PeerSession`, so the candidate gate and ICE priorities apply. All of them selected host → host in the e2e runs. |
| **Media sent to unauthorised viewers** | The `authorize` callback gates joins *and* negotiation messages. Revoked viewers are closed and banned; forced joins by unselected or removed users get no connection (e2e). |
| **Memory / listener leaks** | Room services use a `Disposer`; the speaker detector and stats intervals stop on leave; the call view disposes its listeners; the UI manager is a singleton that is re-attached, never re-created. |
| **Responsive layout** | 5 layouts × desktop, tablet and phone with 5 participants: no horizontal scroll, main video and End control within the viewport, and Sidebar becoming a horizontal strip on phones (e2e). The audience and add-participant pickers are bottom sheets on phones. |

### Remaining limitations

- **Room names are not secrets:** anyone who knows a room name can join it. There is no signaling authentication (ScaleDrone JWT is recommended).
- **Stream metadata is visible:** live-stream titles and allowed-viewer ids are visible to room members. Media access is what's enforced.
- **Mesh upload cost:** the streamer's upload grows linearly with viewers, and group upload grows with N−1. The caps are 6 participants and 8 viewers.
- **Active speaker is signal-based:** detection uses received audio levels, so background noise can win. Pinning overrides it.
