# MeshCall – P2P-first WebRTC mesh calling

![MeshCall](public/banner.png)

A browser VoIP and video app built with Vite, TypeScript, WebRTC and ScaleDrone signaling. It supports:

- 1:1 audio and video calls
- group calls
- open invites (drop-in group calls people can join, leave and rejoin until the initiator ends them)
- live streaming

It uses **mesh topology only**: there is no SFU, MCU or media server. Media always flows browser to browser. When direct connectivity is impossible, media goes through a TURN relay.

```bash
cp .env.example .env      # dev servers are pre-filled
npm install
npm run dev               # http://localhost:5173
npm run build             # type-check + production bundle in dist/
npm test                  # unit tests (vitest)
```

To test on phones or other PCs on your LAN, use `npm run dev:lan`. It serves over HTTPS with a self-signed certificate. HTTPS is required because camera, microphone, Service Worker and Push all need a secure context.

---

## Contents

0. [Rooms, layouts, 1:1 → group, live audience](#rooms-layouts-11--group-live-audience)
1. [Architecture](#architecture)
2. [Mesh topology](#mesh-topology)
3. [Signaling](#signaling-scaledrone)
4. [Presence](#presence)
5. [1:1 call flow](#11-call-flow)
6. [Group call flow](#group-call-flow)
7. [Open invites (drop-in group calls)](#open-invites)
8. [Live stream](#live-stream)
9. [P2P-first strategy, STUN and TURN fallback](#p2p-first-strategy)
10. [Join and rejoin behaviour](#join--rejoin-behaviour)
11. [ICE restart and recovery](#ice-restart--recovery)
12. [Perfect Negotiation](#perfect-negotiation)
13. [Push notifications and Service Worker](#push-notifications--service-worker)
14. [Data usage and bandwidth monitoring](#data-usage--bandwidth-monitoring)
15. [Weak network handling](#weak-network-handling)
16. [Direct messages and offline users](#direct-messages-and-offline-users)
17. [In-call chat, Picture-in-Picture and fullscreen](#in-call-chat-picture-in-picture-and-fullscreen)
18. [Diagnostics: TURN, STUN and WebRTC debugging](#diagnostics--turn--stun--webrtc-debugging)
19. [Configuration and security](#configuration--security)
20. [Browser limitations](#browser-limitations)
21. [Mesh scalability limitations](#mesh-scalability-limitations)
22. [Testing](#testing)
23. [Developer guide: how calls and peers are connected](#developer-guide-how-calls-and-peers-are-connected), for refactoring or plugging in another VoIP stack

More detail:

- [`docs/WEBRTC_EXPLAINED.md`](docs/WEBRTC_EXPLAINED.md) walks through every flow step by step: who sends what, when, and what happens on late, duplicate or lost messages.
- [`docs/SELF_AUDIT.md`](docs/SELF_AUDIT.md) lists the issues found during the final audit, each with its root cause, impact and fix.

---

## Rooms, layouts, 1:1 → group, live audience

### Rooms

- **A page load asks for a room unless a room was active when the app was closed**, in which case that room is reopened (see *Reopening the last room* below). Recently used names are offered as chips that only fill the input; you still have to press Join. A notification click may prefill the room (`?room=`), but still needs Join.
- **Validation:** room names are trimmed, internal whitespace is collapsed, and Unicode is NFKC-normalised. They must be at most 64 characters, using only letters, digits, spaces and `- _ . '`.
- **`roomId`:** the lower-cased, dash-joined name, e.g. "Engineering Team" → `engineering-team`. It is stamped on every signaling message.
- **`roomKey`:** a 64-bit FNV hash of the `roomId`, used to build ScaleDrone room names: `observable-room-<key>` and `inbox-<key>-<deviceId>`.
- **Identity:** always the `deviceId`, never the room or display name.
- **Isolation, in two layers:**
  1. Each room uses different ScaleDrone rooms.
  2. `SignalingService` drops every incoming message whose `roomId` isn't the current room. Protocol v2 requires `roomId`, so v1 clients are ignored.

  Calls are further isolated by `callId`, and streams by `streamId` (the stream's `callId`).
- **Lifecycle:**

```mermaid
flowchart LR
  A[Page load] --> R[Room screen] --> J[joinRoom: scope signaling → room presence → room inbox → live discovery → wait for member list, 15 s]
  J -->|ok| U[Users & calls]
  J -->|timeout / ScaleDrone down| R
  U -->|Leave Room| L[end call/stream · close peer connections · stop media · unsubscribe · clear presence/streams/chat · drop room scope] --> R
```

The top bar shows **Room: name**, with **Copy** (copies only the name, never any credential) and **Leave**.


**Reopening the last room:**

- **Close or reload while in a room:** the next launch rejoins that room automatically, using the normal join path. If the join fails, the room screen shows the error with the room prefilled.
- **Clicking Leave room:** clears the saved room, so the next launch asks *"Which room do you want to join?"* again.
- **Switching rooms:** joining a new room saves it instead.

A notification launch, or a `?room=` link, still takes priority and only prefills its room. The saved room is stored under `localStorage` key `voip.activeRoom`, and holds the room name only.

### Call layouts

`CallLayoutManager` (`src/ui/layout/`) is pure logic. It turns the tiles, the pinned participant and the active speaker into a `LayoutPlan`: the main tile(s), the strip order, and the effective layout. `VideoGrid` renders that plan by *moving* the existing tiles between the main area and the strip. Switching layout never touches an `RTCPeerConnection`, `MediaStream`, SDP or ICE; the e2e test verifies that the same `pcId` and the same `<video>` element survive, and that media keeps flowing.

| Layout | Desktop / tablet | Phone |
|---|---|---|
| Grid | responsive equal tiles | 1 or 2 columns |
| Speaker | active speaker large + equal row | main + horizontal strip |
| Spotlight | one person full size + small chips | same |
| Sidebar | main + vertical column | main + **horizontal** strip |
| Filmstrip | main + scrollable thumbnails | same |

- **Main participant, in priority order:** pinned (click a tile; click again to unpin) → active speaker (Speaker layout) → screen share → active speaker → first remote with video → you. The same participant is the PiP target.
- **Active speaker:** detected from `RTCRtpReceiver.getSynchronizationSources().audioLevel`, read about 4×/s. There is no WebAudio pipeline. EWMA smoothing, a sustained lead of 0.9 s at 1.5× loudness, and a minimum 2.5 s dwell prevent flicker.
- **Picker:** the Layout control (on phones: More → Layout) opens a picker, which becomes a bottom sheet on phones. The choice is saved as a per-device preference.

### Adding people to a call (1:1 → group)

```mermaid
sequenceDiagram
  participant A as Alice
  participant B as Bob
  participant C as Carol
  Note over A,B: 1:1 call, A↔B connected
  A->>B: call-participants-added {participantIds:[C]} (mesh room)
  Note over A,B: both mark the call "group" – A↔B RTCPeerConnection untouched
  A->>C: call-invite {callKind: group, participants:[A,B]}
  C->>A: call-accept
  C->>A: mesh-join {invitedBy: A}
  C->>B: mesh-join {invitedBy: A}
  Note over A,C: impolite side offers → P2P first → STUN → TURN
  Note over B,C: impolite side offers → P2P first → STUN → TURN
```

- **Who may add:** any current participant, through **Add** (desktop) or **More → Add** (phones). Receivers accept `call-participants-added` only from a participant of that exact call.
- **Group access policy:** participants + invitees + joiners vouched for by an allowed participant (`invitedBy`). Welcomes (replies to our own join) are trusted. The e2e verifies that a forged add or join from a non-participant gets no connection.
- **Duplicates:** people already in the call or already invited are skipped.
- **Unanswered invites:** declines, busy, no answer and offline each produce a toast. The call itself is never affected.
- **Rejects:** only the host can reject a joiner, so a race between two simultaneous invitees can't break the call.
- **Mesh cap:** 6 participants.
- **Rejoin:** a participant who reloads rejoins with a fresh `RTCPeerConnection`, so P2P is attempted again.

### Live-stream audience

- **Go live** asks *Who can watch?*: **Everyone** in the room, or **Selected participants** from a room checklist.
- **Enforcement:** the audience is enforced inside the broadcaster's mesh (the `authorize` callback), on every join *and* every negotiation message. An unselected user never gets an `RTCPeerConnection`, so the media is never sent to them; the video element isn't merely hidden. A forced join by an unselected user is refused (e2e).
- **Manage audience** (while live):
  - A removed viewer's connection is closed (media stops immediately), and they are barred from reconnecting.
  - An added viewer is invited and connects P2P-first.
  - Nobody else's connection is touched.
- **Audience panel:** shows each person as *Streaming / Connecting / Can watch / Invited / Not selected / Disconnected*, with the **measured upload per viewer** and the total, taken from WebRTC transport stats, not estimated.
- **Signaling:**

| Message | Direction |
|---|---|
| `live-started` (+ heartbeat) | lobby |
| `live-audience-updated` | lobby |
| `live-stopped` | lobby |
| `live-viewer-added` | streamer → viewer inbox |
| `live-viewer-removed` | streamer → viewer inbox |
| `live-viewer-joined` | viewer → streamer |
| `live-viewer-left` | viewer → streamer (also sent on page unload, so the upload slot is freed immediately) |

  All of them carry `roomId`, `callId` = `streamId`, `senderId`, `messageId` and `timestamp`, plus `targetUserId` where it applies. Audience-changing messages are accepted only from the stream's own streamer.
- **Signaling confidentiality:** ScaleDrone without JWT is not confidential, so stream titles and allowed ids are visible to room members. The access control applies to the **media**.
- **Viewer reconnect:** the viewer is re-authorised on join. Allowed viewers get a fresh P2P-first connection; revoked viewers are refused.

## Architecture

```
src/
├── main.ts                     bootstrap (onboarding → services → UI)
├── app.ts                      composition root (creates + wires every service)
├── config.ts                   env-driven config, ICE servers (no secrets in code)
├── core/                       logger, typed emitter, async helpers, storage, formatting
├── types/                      signaling protocol, call/peer state, ScaleDrone typings
├── services/
│   ├── IdentityService         persistent deviceId + display name, per-load sessionId
│   ├── SignalingService        ScaleDrone transport, dedupe, outbox, liveness watchdog
│   ├── PresenceService         online/offline/connecting/unknown via observable lobby
│   ├── NetworkMonitor          online/offline, connection type, sleep/wake, resume
│   ├── NotificationService     in-app system notifications + SW click bridge
│   ├── PushNotificationService Web Push lifecycle against the existing push backend (src/push/)
│   ├── RoomService             room-name validation/normalisation, roomId + roomKey
│   ├── ChatService             call-scoped text chat over the mesh room (dedupe, ordering, unread)
│   ├── SettingsService         quality, devices, ICE test mode
│   └── Ringtone                WebAudio ring/ringback
├── media/
│   ├── MediaManager            getUserMedia, mute, camera, screen share, device swap
│   ├── DeviceManager           enumerateDevices, hot-plug, permission changes
│   └── QualityPresets          Low/360p/480p/720p/1080p + audio bitrates
├── webrtc/
│   ├── WebRTCManager           RTCPeerConnection factory (P2P-first config)
│   ├── PeerSession             one RTCPeerConnection: Perfect Negotiation, ICE queueing
│   ├── PeerConnectionManager   sessions per remote, rejoin/recreate, stale-message filter
│   ├── IceStrategy             candidate gate (P2P window) + path classification
│   ├── ConnectionRecoveryManager  disconnected/failed → ICE restart → recreate
│   ├── StatsMonitor/StatsParser   getStats() polling and parsing (selected pair = truth)
│   ├── DataUsageMonitor        per-call byte accounting across reconnects
│   ├── AdaptiveLadder/AdaptiveQualityManager  hysteresis-based video adaptation
│   ├── IceServerProbe          STUN/TURN health check
│   └── ActiveSpeaker           audio-level (getSynchronizationSources) speaker detection + hysteresis
├── calls/
│   ├── CallManager             call state machine, invites, accept/reject/hangup, rejoin
│   ├── CallStateMachine        allowed status transitions
│   ├── MeshSession             membership protocol + wiring for one call/stream
│   ├── GroupCallManager        create/add/remove/leave
│   ├── InviteManager           open invites: announce, Join list, end for everyone
│   └── LiveStreamManager       go live, discovery, viewer cap
└── ui/                         UIManager + views (grid, call, chat, sidebar, dialogs, diagnostics)
    ├── layout/CallLayoutManager  grid · speaker · spotlight · sidebar · filmstrip (pure logic)
    ├── views/RoomScreen        "Join a Room" – shown on every page load
    ├── ViewModeController      Picture-in-Picture + Fullscreen, synced with the browser APIs
    └── views/ChatPanel         chat list + composer (Enter = send, Shift+Enter = newline)
public/sw.js                    Service Worker (push → notification → open/focus app)
```

```mermaid
flowchart LR
  UI[UIManager & views] --> CM[CallManager]
  CM --> MS[MeshSession]
  MS --> PCM[PeerConnectionManager]
  PCM --> PS[PeerSession ×N]
  MS --> REC[ConnectionRecoveryManager]
  MS --> STATS[StatsMonitor]
  STATS --> DU[DataUsageMonitor]
  STATS --> AQ[AdaptiveQualityManager]
  PS --> GATE[CandidateGate]
  CM --> SIG[SignalingService]
  MS --> SIG
  PCM --> SIG
  PRES[PresenceService] --> SIG
  CM --> MEDIA[MediaManager]
  NET[NetworkMonitor] --> CM --> MS --> REC
  CM --> PUSH[PushNotificationService]
  SIG <-->|WebSocket| SD[(ScaleDrone)]
  PS <-->|SRTP / DTLS| PEER[(Remote browsers)]
```

The design follows three rules:

- **Call state is separate from DOM state.** Services hold plain data such as `CallState`, `ParticipantState` and `PeerConnectionState`. The UI reads that data and never stores call logic.
- **Signaling state is separate from WebRTC state.** `SignalingService` status, call status and per-peer `RTCPeerConnection` state are independent. For example, a signaling outage does not end a call whose media is still flowing.
- **Each module has one responsibility.** Dependencies are injected in `app.ts`.

## Mesh topology

```
 1:1                      Group (3)                     Live (broadcaster B)
 A ◀────▶ B                   A                          B ──▶ V1
                            ╱   ╲                        B ──▶ V2
                           B ─── C                       B ──▶ V3
```

Each participant keeps one `RTCPeerConnection` per remote participant, so a group of N has N·(N−1)/2 links. In a live stream only broadcaster↔viewer links exist. Viewers never connect to each other.

## Signaling (ScaleDrone)

The app uses channel `EoIG3R1I4JdyS4L1`, configurable with `VITE_SCALEDRONE_CHANNEL_ID`.

| Room | Purpose |
|---|---|
| `observable-room-<roomKey>` | room presence (ScaleDrone member list), heartbeats, live-stream and open-invite announcements |
| `inbox-<roomKey>-<deviceId>` | directed messages within the room: invites, SDP, ICE, welcome, reject… |
| `mesh-<callId>` | broadcast within a call: join, leave, heartbeat, media state, **chat messages** |

Every message is a typed envelope (`src/types/signaling.ts`) containing:

- `messageId`: used for de-duplication (a bounded LRU set)
- `timestamp`
- `messageType`
- `senderId` and `receiverId`: persistent device IDs, never display names
- `senderSessionId`: changes on every reload, so reloads can be recognised as rejoins
- `roomId`: the room scope; messages from any other room are dropped on receipt
- `callId`
- `peerId`: the sender's `RTCPeerConnection` id for negotiation messages
- `payload`

Negotiation messages also carry `pcId` and `targetPcId`. These let a peer discard SDP and ICE addressed to a connection that has since been replaced.

`SignalingService` has four robustness features:

- **Validation:** messages are structurally validated, and our own echoes are filtered out.
- **Outbox:** messages are queued while disconnected and flushed on reconnect. Anything older than 20 s is dropped.
- **Reconnect:** ScaleDrone's own auto-reconnect handles most drops. If ScaleDrone gives up, the client is re-created with exponential backoff.
- **Liveness watchdog:** ScaleDrone echoes our publishes back to us. If a publish is not echoed within 20 s, the socket is presumed dead and the client is re-created. This catches Wi-Fi changes and sleep, where a WebSocket often never errors.

## Presence

Presence uses the ScaleDrone *observable* lobby. Its member list and join/leave events are authoritative. Heartbeats every 20 s carry the display name, a busy flag and push capability.

| State | Meaning |
|---|---|
| **Online** | device has a session in the lobby, or it heartbeated recently |
| **Offline** | left, after a 10 s grace period, so a reload does not flash "Offline" |
| **Connecting** | our own signaling is connecting |
| **Unknown** | our own signaling is down, so we can't observe anyone |

A single missed heartbeat never marks a user offline. On `pagehide` the app sends a best-effort `presence-leave`, which makes a tab close show as offline immediately. Known users are kept in `localStorage`, so offline users still appear in the list.

## 1:1 call flow

```mermaid
sequenceDiagram
    participant A as User A (caller)
    participant S as ScaleDrone
    participant B as User B (callee)

    A->>S: call-invite (inbox-B)
    S->>B: call-invite
    B->>S: call-ringing
    S->>A: call-ringing  (A: Calling → Ringing)
    B->>S: call-accept
    S->>A: call-accept   (A: Connecting)
    Note over A,B: both subscribe mesh-<callId>
    A->>S: mesh-join (broadcast)
    S->>B: mesh-join
    B->>S: mesh-welcome
    Note over A,B: impolite side (id comparison) creates the RTCPeerConnection
    A->>S: SDP offer
    S->>B: SDP offer
    B->>S: SDP answer
    S->>A: SDP answer
    A->>B: host ICE candidates (immediately)
    B->>A: host ICE candidates
    A->>B: srflx (STUN) candidates
    Note over A,B: direct P2P attempted first (ICE priorities)
    A-->>B: relay (TURN) candidates – held for DIRECT_P2P_TIMEOUT_MS,<br/>sent as standby once direct succeeds, or as fallback if it does not
    A<<->>B: SRTP media (direct, or via TURN)
```

Call statuses are Idle, Calling, Ringing, Connecting, Connected, Reconnecting, Ended, Failed, Rejected and Busy. Transitions are validated by `CallStateMachine`, and each status has its own UI. Every waiting state has a timeout, so the user is never left on a permanent spinner:

| Waiting state | Timeout |
|---|---|
| ringing | 45 s |
| no ringing ack from an offline callee | 8 s |
| accept → connect | 25 s |
| reconnecting | 45 s |

## Group call flow

1. The host creates the call, joins `mesh-<callId>`, and sends `call-invite` to each selected user.
2. Each invitee accepts and broadcasts `mesh-join`. Existing members reply with `mesh-welcome`.
3. For each pair, the **impolite** peer creates the connection and sends the offer.
4. Every member heartbeats every 10 s. The heartbeat carries its role, media state, and its `pcId` for every peer. This heals missed joins and detects orphaned one-sided connections.
5. **Leave:** the member broadcasts `mesh-leave`, and peers close only that member's connection.
6. **Remove participant:** the host broadcasts `mesh-remove`. The target leaves and is barred from rejoining.
7. **Add participant:** sends a new `call-invite` for the same `callId`.

The group is capped at `mesh.maxParticipants` (6), and the host enforces the cap.

## Open invites

An **open invite** is a drop-in group call. One user opens it for everyone in the room or for selected people. Invited people get a **Join** button and can join, leave and rejoin as many times as they like. It stays open until the initiator ends it.

### Using it

1. **Start:** use **Start invite** in the ⋮ menu, or the **+** button next to *Invites* in the Live tab. Pick:
   - a title (optional);
   - **Video call** or **Audio call**;
   - **Everyone** (anyone in the room) or **Selected participants**.

   Starting it also puts the initiator straight into the call.
2. **Invited people:**
   - get a toast *"X invited you to …"* with **Join** (when they are in another call, the toast says to join later);
   - see the invite under **Live → Invites** with a **Join** button, and the Live tab badge counts open invites;
   - people who come online later see it within 10 s (the next announcement).
3. **Join / leave / rejoin:** **Join** enters the call; **Leave** leaves only you. Everyone else stays connected, and you can join again at any time while the invite is open.
4. **End:** only the initiator can end the invite, either with **End** in the Invites list or **End invite** in the call's *More* menu. After a confirmation, the call ends for everyone and the invite disappears from every list.

| Situation | What happens |
|---|---|
| Initiator **leaves the call** | The invite stays open and others carry on. The initiator gets a toast with **End invite** and can rejoin from the list. |
| Initiator **reloads** the page | The invite is restored from `sessionStorage` and announcements resume. The call itself is rejoined through the normal *Rejoin* banner. |
| Initiator **leaves the room** | The invite is ended (`invite-stopped`), and the call ends for everyone. |
| Initiator **closes the app / loses the network** | Announcements stop, so the invite disappears from lists after 35 s. People already in the call can continue until they leave. |
| Not invited (selected mode) | The invite is never listed. If such a device sends `mesh-join` anyway, every participant rejects it. |
| Already in another call | **Join** is disabled until that call ends. |
| Call is full | Same cap as group calls (`mesh.maxParticipants` = 6). The initiator rejects extra joins with `mesh-reject: full` while they are in the call. |

### Protocol

```mermaid
sequenceDiagram
    participant H as Initiator
    participant L as Lobby (observable-room)
    participant P as Invitee
    participant M as mesh-<inviteId>

    H->>L: invite-started {inviteId, title, media, audienceMode, allowedIds?}
    Note over H: joinInvite() → group MeshSession (callId = inviteId)
    H->>M: mesh-join
    L->>P: invite-started (toast + Join)
    loop every 10 s
      H->>L: invite-started {heartbeat: true}
    end
    P->>M: mesh-join (on Join)
    M->>H: mesh-join
    H->>P: mesh-welcome (inbox)
    Note over H,P: impolite side offers → normal P2P-first negotiation
    P->>M: mesh-leave (Leave) … mesh-join again (Rejoin)
    H->>L: invite-stopped {inviteId}
    Note over P: in that call → "X ended the invite" (call ends)
```

- **Messages:**
  - `invite-started` (payload `OpenInviteInfo`): the first announcement and every heartbeat.
  - `invite-stopped`: the invite is closed.

  Both go to the room lobby. Receivers accept them **only from the invite's own initiator**; the first sender of an `inviteId` owns it.
- **The call:** an ordinary **group** call with `callId = inviteId`. There is no `call-invite` / ringing / accept handshake: the announcement is the invitation, and **Join** is `CallManager.joinInvite()` → `startMesh()` → `mesh-join`. The membership, negotiation, recovery and leave paths are exactly those of group calls.
- **Access** is enforced in media negotiation, not only in the UI:
  - each participant's `MeshSession` allow-list is `[initiator, ...allowedIds]` (selected mode), or open (`null`) for *Everyone*;
  - `InviteManager` re-applies it from each announcement through `MeshSession.setAccess()`, which also fixes the list after a participant reloads and rejoins.
- **Ending:** on `invite-stopped`, anyone in that call is terminated with *"X ended the invite"*. An invite not announced for 35 s is dropped from lists, but the running call is not torn down.

## Live stream

The broadcaster joins as `broadcaster` and announces the stream in the lobby every 15 s. Viewers join as `viewer`:

- Transceivers are `sendonly` on the broadcaster and `recvonly` on viewers.
- Only broadcaster↔viewer links are created.
- When the broadcaster leaves, viewers see **Stream ended**.
- Viewers are capped at `mesh.maxLiveViewers` (8) and are rejected with `mesh-reject: full` beyond that.

> **Mesh bandwidth warning:** there is no media server, so the broadcaster uploads one full copy of its stream per viewer. At 1 Mbps and 8 viewers that is about 8 Mbps of upstream. The UI shows this warning before going live.


### Calling someone into a live stream

While you are live, **Call** (in the sidebar, or the phone button next to a viewer in the audience panel) invites that person into the stream instead of starting a separate call. If the audience is *Selected*, they are added to it. They then join as a normal viewer, so the WebRTC and live-stream path is unchanged.

- **Online:** they get a ringing invitation (the *Incoming live stream call* dialog) and the incoming-call ringtone until they choose **Watch** or **Not now**, or the ring timeout passes. A system notification is also shown if their tab is hidden.
- **Offline or unknown:** a **targeted** `incoming-call` push with `callType: 'live'` goes to that person only, through `PushNotificationService.notifyIncomingCall`. It is never broadcast. The current backend can't target a device, so no push is sent: the streamer is told so, and the person is rung **as soon as they come online** in the room within the ring window. Once the backend supports `POST /notify`, the push is sent with no other changes. Its notification reads *Live Stream Invitation — Host invites you to watch “Title” in Room*.

## P2P-first strategy

The strategy has two layers. Neither uses an arbitrary delay to hide a race.

**1. Native ICE prioritisation**

Configuration: `iceTransportPolicy: "all"`, `bundlePolicy: "max-bundle"`, `iceCandidatePoolSize: 2`.

RFC 8445 type preferences rank host (126) above prflx (110) above srflx (100) above relay (0). As a result, a working direct pair always outranks a relayed one. SDP priorities are **not** munged, because the browser defaults already express "direct first". Relay-only mode is never used in the normal flow.

**2. `CandidateGate`: the P2P window** (`src/webrtc/IceStrategy.ts`)

- Host and srflx candidates are trickled immediately.
- Local **relay** candidates are still gathered in parallel, so a TURN allocation is ready with no extra latency if it is needed. However, they are **held back** from the remote peer until one of these happens:
  - direct connectivity succeeds; the relay candidates are then sent as a *standby* fallback path;
  - `DIRECT_P2P_TIMEOUT_MS` (default 3000) elapses without a connection;
  - ICE reports `disconnected` or `failed`;
  - gathering finished and no non-relay candidate exists at all.
- An optional `HOST_ONLY_WINDOW_MS` also holds srflx candidates, giving host↔host (LAN) pairs a head start. It defaults to 0 because ICE priorities already prefer host pairs, so delaying srflx only slows down calls between different networks.
- The gate **never tears anything down**. It only decides *when* fallback candidates become available. A connection that is making progress is never interrupted.
- The gate is **re-armed on every new ICE generation**: a fresh connection, any ICE restart, or a rejoin. Each of these therefore gives direct P2P a new head start.

```
Peer connection ─┬─ host ↔ host ............................ P2P (LAN)
                 ├─ srflx involved (STUN-discovered NAT path) STUN (media still direct)
                 └─ relay (after the P2P window / failure) .. TURN
```

The chosen path is **never inferred from configuration**. `StatsMonitor` reads `getStats()` to find it:

1. Take `transport.selectedCandidatePairId`. Browsers without it fall back to `candidate-pair.selected`, or to a nominated and succeeded pair.
2. From that pair, read `local-candidate.candidateType` and `remote-candidate.candidateType`.
3. Classify the path with `classifyPath()`:
   - either side `relay` → **TURN**
   - `host → host`, or `prflx` between private addresses → **P2P**
   - otherwise → **STUN**

"TURN is required" is **never cached**. Every new connection, rejoin or ICE restart starts over at "direct first".

STUN always tries Google's public STUN servers first, then `stun:aahlaad.in:3478` (see `orderStunUrls` in `src/config.ts`). Google's servers are STUN only; Google offers no public TURN. The TURN relay fallback is `turn:aahlaad.in:3478`. All of these are configurable.

## Join and rejoin behaviour

```mermaid
flowchart TD
  J[Participant joins] --> PC[Create RTCPeerConnection<br/>host + STUN + TURN, policy 'all']
  PC --> N[SDP negotiation]
  N --> H[Trickle host + srflx now<br/>hold relay candidates]
  H --> Q{Direct pair connected<br/>within P2P window?}
  Q -- yes --> P2P[Use P2P / STUN path<br/>send relay as standby]
  Q -- no --> R[Release relay candidates]
  R --> T{Connected?}
  T -- yes --> TURN[Connected via TURN]
  T -- no --> REC[Recovery: ICE restart → re-create]

  RJ[Participant rejoins] --> D[Discard stale peer state<br/>retire old pcIds, drop stale SDP/ICE]
  D --> PC
```

| Situation | What happens |
|---|---|
| Remote **reloads** (new `sessionId`) | Its old connection is closed and its old `pcId` retired. A brand-new `RTCPeerConnection` is created, so P2P is tried first again. |
| Remote **re-announces** with the same session (its signaling reconnected, and its network may have changed) | ICE restart on *that link only*. Other participants are untouched. |
| Offer arrives from a new remote `pcId` | The remote re-created its side, so a fresh connection is built here too. |
| SDP or ICE from a **retired** `pcId`, or addressed to one of our old `pcId`s | Dropped. |
| We reload during a call | A **Rejoin** banner appears. The saved call is kept in `sessionStorage` for 15 min. Rejoining is a fresh negotiation with everyone. |

## ICE restart and recovery

`ConnectionRecoveryManager` applies this policy per peer:

| Trigger | Action |
|---|---|
| `connected` | reset attempts |
| `disconnected` | wait 3 s (ICE often self-heals), then ICE restart |
| `failed` | ICE restart immediately |
| restart did not reconnect in time (10 s, 20 s, 30 s…) | ICE restart again |
| more than `maxIceRestarts` (3) restarts | re-create the `RTCPeerConnection` (full renegotiation); a circuit breaker allows at most 4 per peer per minute |
| negotiation stalled (offer re-sent twice, no answer) | re-create |
| browser **offline** | pause; attempts are not consumed |
| `online` / connection-type change / wake from sleep | ICE restart on **every** peer, because the path may be stale and direct P2P should be tried again |
| tab resumed after being hidden > 30 s / bfcache restore | ICE restart on unhealthy peers |
| signaling reconnected | re-announce in the mesh; restart unhealthy peers (a lost offer is re-sent by the negotiation watchdog) |

`navigator.onLine` is only a **hint**. It triggers re-validation and is never treated as proof that WebRTC works.

`pc.restartIce()` produces new ICE credentials. That means fresh gathering, a re-armed P2P window, and host candidates first again. ICE restart is make-before-break, so media keeps flowing on the old pair until a new pair is selected.

## Perfect Negotiation

`PeerSession` implements the W3C pattern:

- **Deterministic roles:** `polite = "${deviceId}|${sessionId}" > remote's`. Exactly one side of each pair is polite, even for two tabs on the same device.
- **Collision detection:** uses `makingOffer`, `ignoreOffer` and `isSettingRemoteAnswerPending`. The polite peer rolls back its own offer (implicit rollback). The impolite peer ignores the colliding offer.
- **Serial processing:** all incoming SDP and ICE for a peer is processed through a `SerialQueue`, so operations never interleave.
- **Stale answers:** an answer received while not in `have-local-offer` is a stale or duplicate answer and is ignored.
- **Initial offer:** only the impolite peer makes it, so a normal join never produces glare. Perfect Negotiation still covers later collisions, such as simultaneous ICE restarts, simultaneous re-creation, or a join during renegotiation.
- **Candidate queueing:** candidates that arrive before their SDP are queued per remote `pcId`. The same applies to a future ICE generation, detected when its `usernameFragment` differs. Queued candidates are applied after `setRemoteDescription`. Duplicates are de-duplicated by (ufrag, mid, candidate). A failing `addIceCandidate` is caught and never breaks the connection.
- **Lost messages:** a lost offer or answer is re-sent by a watchdog, and then escalated to re-creation.

## Install as an app, offline shell and updates

- **Installable app (PWA):** a web app manifest provides the name, `standalone` display, theme colours, 192/512 px PNG icons, a maskable icon and an Apple touch icon. Together with the Service Worker this meets Chrome's install criteria; the e2e test asserts zero installability errors.
  - **Chromium desktop and Android:** the app captures `beforeinstallprompt` and shows its own **Install** button (sidebar, idle screen, Settings → App).
  - **iOS/iPadOS:** there is no install API, so **Install** opens a *Share → Add to Home Screen* guide.
  - Installed state is detected (`display-mode: standalone`), and the button disappears.
- **Service Worker (`public/sw.js`):**
  - It is registered at boot, before the name screen, and scoped to the app's base path (works under `/meshcall/` on GitHub Pages).
  - At build time a small Vite plugin stamps `sw.js` with a unique `BUILD_ID` and the exact list of emitted files, so each release precaches its own hashed JS/CSS, HTML, icons and manifest.
  - Pages are network-first (4 s), falling back to the cached shell, then to an offline page.
  - Hashed assets are cache-first.
  - Cross-origin requests (ScaleDrone, the push relay) are never intercepted.
  - In `vite dev` it runs in pass-through mode, so HMR is unaffected.
- **Offline:** the installed app still opens without a network (you get the room screen, with signaling "unavailable"). When the network returns, signaling reconnects by itself.
- **Updates never interrupt a call:**
  - A new release installs in the background and **waits**.
  - The app shows *"A new version of MeshCall is available [Reload]"*, and asks for confirmation during a call.
  - It checks for updates every 30 min and whenever the app returns to the foreground.

## Push notifications

MeshCall uses the **existing push backend `https://web-push-3zaz.onrender.com`**. Override it with `VITE_PUSH_SERVER_URL`; its code default is `PUSH_SERVER_URL` in `src/config.ts`. The frontend implements exactly its API:

| Endpoint | Used for |
|---|---|
| `GET /vapid` | VAPID **public** key (validated: 65-byte P-256 point; never cached if invalid) |
| `POST /subscribe` | the browser's `PushSubscription.toJSON()`, unchanged |
| `POST /isPushSubscribed` `{endpoint}` | startup verification, keeping the UI in sync |
| `POST /unsubscribe` `{endpoint}` | turning notifications off (a 404 counts as already gone) |
| `POST /notifyAll` | **development-only** test button; never used for calls |

### Architecture

- **Code layout:**
  - `src/push/PushBackend.ts` is a backend adapter; `WebPushServerBackend` implements the contract above.
  - `src/push/payloads.ts` defines the typed payloads (`PushNotificationType`, `IncomingCallPush`, `CallLaunchContext`).
  - `src/push/base64url.ts` converts Base64URL to a `Uint8Array`.
  - `src/services/PushNotificationService.ts` provides `initialize`, `getPermissionState`, `requestPermission`, `getSubscription`, `subscribe`, `unsubscribe`, `isSubscribed`, `refreshSubscription`, `notifyIncomingCall` and `diagnostics`.
- **Source of truth:** `pushManager.getSubscription()`. `localStorage` only remembers that the user *wanted* push.
- **Startup:**
  1. Wait for the Service Worker, then call `getSubscription()`.
  2. `POST /isPushSubscribed`, and re-register if the server lost the subscription.
  3. If the subscription was created with an old VAPID key, re-subscribe.
  4. If it expired while the user wants push, recreate it.
  5. Transient backend errors are retried at 5 s, 20 s and 60 s, and again on `online` and on `pushsubscriptionchange`.
- **Permission is only requested from a click:** Settings → Notifications → **Incoming calls** switch, or the idle-screen **Enable Notifications** card. When the browser has denied it, the app shows per-browser unblock instructions and never re-prompts.
- **States:** Enabled / Disabled / Connecting / Blocked by browser / Unavailable (with the reason). They appear in Settings and in Diagnostics → Push Notifications. The diagnostics show support, permission, SW state, the subscription and server confirmation, a redacted endpoint, the server URL, the last registration, and targeting capability. Subscription keys are never shown or logged.

### Targeted delivery (calls, private messages)

The backend (`aquibahmed21/web-push`) was extended with targeted delivery:

```text
POST /subscribe  { ...PushSubscription.toJSON(), deviceId }     subscription + this MeshCall device id
                                                                (re-registering a known endpoint attaches/updates the id)
POST /notify     { targetDeviceId, title, body, data, ttl }     push ONLY to that device's subscriptions
                 → 200 {successes, failures} | 404 {error} no subscription for the device
payload delivered = { title, body, data }   data = incoming-call | chat-message payload (see src/push/payloads.ts)
```

- **Senders:**
  - An **incoming call** to someone who is not online sends `POST /notify`. This includes direct calls, group invites and live-stream invitations.
  - A **private message** to an offline user sends `POST /notify` too.
  - The caller does not need push enabled; only the recipient does.
  - `/notifyAll` is never used for calls or messages.
- **Results:**
  - `accepted`: the push server took it, which is not proof of delivery.
  - `not-subscribed` (404 JSON): the recipient never enabled notifications. The call ends with *"X is offline and hasn't enabled call notifications"*, and a message stays queued.
  - `unsupported`: an HTML 404 means a server without `/notify`.
- **Existing subscriptions** get their `deviceId` attached automatically: the app re-registers idempotently on every start.
- **Known backend limitations** (not changed here):
  - `/notify` is unauthenticated, so anyone who knows a device id can send it a notification. Add auth, for example a signed token, and rate limiting before wider use.
  - Subscriptions live in `notifications.json` on Render's ephemeral disk, and are lost on restart or redeploy until each device opens MeshCall again. Use a persistent store.
  - The VAPID **private** key is committed in `notifications.json`. Move the keys to environment variables. Rotating them invalidates every subscription.

### Service Worker (`public/sw.js`)

- **Registration:** at `${BASE_URL}sw.js` with scope `${BASE_URL}`, i.e. `/meshcall/` on GitHub Pages. This is verified by the e2e test.
- **`push`:** payloads are parsed defensively:
  - `incoming-call` → *"Incoming Video Call — Alice is calling you in Engineering"*, with an **Open MeshCall** action;
  - `{title, body}` and `{notification:{…}}` (the `/notifyAll` style) → a generic notification;
  - plain text → a generic notification;
  - a malformed payload → a generic notification. The worker never crashes.
- **Visible app:** if MeshCall is visible, the worker posts the call to the page instead of notifying, so there is no duplicate.
- **`notificationclick`:**
  - The notification is closed, and the worker focuses an existing MeshCall window and `postMessage`s the call context.
  - If no window exists, it stores the context in a short-lived Cache entry and opens `/meshcall/`. **No call data goes in the URL.**
  - The app reads the context once, asks for or switches to the call's room, and then the call rings with the normal **Accept / Reject** dialog. **Nothing is auto-accepted.**
- **`notificationclose`:** dismissing is not declining; the page is informed.
- **`pushsubscriptionchange`:** the page re-registers the new subscription.

**Limitation:** a Service Worker cannot hold a WebRTC call. Push only shows the notification. The chain is: user opens MeshCall → app starts → ScaleDrone connects → room joined → the caller re-sends the invite → WebRTC negotiation.

**CORS:** the backend allows `https://aquibahmed21.github.io` and `http://localhost:5173` (verified). Any other deployment origin must be added to the backend's CORS configuration. The frontend never tries to bypass CORS.

## Direct messages and offline users

**Buttons are never disabled because someone is offline.** Every person in the room keeps **Audio call**, **Video call** and **Message**.

**Calling a user who is not online** (offline, or presence unknown) never starts a blind WebRTC attempt. Instead a dialog says *"John is currently offline"* (or that the status is unknown):

- **Send Call Notification** appears only when targeted push is actually available and the recipient is known to have push enabled. That is not the case with the current backend.
- Otherwise the dialog explains why no notification can be sent and offers **Message instead** or **Cancel**.

**Direct messages** (`src/services/DirectMessageService.ts`, `ConversationDrawer`) are 1:1 conversations, available in and outside calls:

| Recipient presence | Delivery |
|---|---|
| **online** | ScaleDrone, to the recipient's room inbox → the recipient's app sends `direct-message-ack` → **Delivered** |
| offline / **unknown** (unknown is never treated as online) | `PushNotificationService.sendToUser()`, a **targeted** push; never `/notifyAll` |
| … with the current backend (`'unsupported'`) | **Waiting for recipient**: queued on this device with an explanation, and sent through ScaleDrone automatically when the recipient comes online |

- **Message states:**
  - Sending / Sent (published, no ack yet) / **Delivered** (the recipient's app acknowledged it);
  - Waiting for recipient;
  - **Push request accepted**: the push server accepted the request, which is *not* shown as Delivered;
  - Failed.
- **No duplicates:** a sent message with no ack within 15 s goes back to *Waiting*. Retries reuse the `messageId`; the recipient de-duplicates but always acks, so a lost ack never creates a duplicate.
- **Acks** are only accepted from the recipient.
- **Unread counts** appear as a badge on the Message button. An in-app toast offers **Open**. A system notification (tag `dm-<sender>`) is shown only when the tab is hidden or unfocused.
- **Room isolation:** conversations are stored per `roomId` (`voip.dm.<roomId>`). Signaling already drops other rooms' messages, and persisted entries are filtered by `roomId` again when loaded.
- **Security:** text is always rendered with `textContent` and limited to 2,000 characters.

**Chat notification click:** the Service Worker handles `chat-message` pushes. If the app is visible it posts to the page and shows no system notification. Otherwise it shows *"New message from Alice"*. A click focuses or opens MeshCall and hands the context over by `postMessage`, or by a one-time Cache entry. **The URL never carries message data.** The app then:

1. enters or offers the correct room;
2. opens the conversation and highlights the message;
3. closes the notification.

### Backend changes required for targeted push (not implemented – the backend is not modified here)

The current backend stores bare subscriptions and can only broadcast. Delivering calls and messages to *one* offline user needs:

```text
POST /subscribe   { subscription, deviceId }         associate a subscription with a MeshCall device (+ auth)
POST /notify      { targetDeviceId, title, body, data }   deliver to that device's subscriptions only
      data = { type:'incoming-call', callId, roomId, roomName, callerId, callerName, callType, timestamp, expiresAt }
           | { type:'chat-message', messageId, senderId, senderName, text, roomId, roomName, timestamp }
      → 202 {accepted:true} | 404 {error:'no subscription for device'} | 401/403
```

- **Authentication:** the sender must be authenticated, for example with the same JWT as ScaleDrone, and rate-limited, so nobody can push to arbitrary devices.
- **Response:** `/notify` should also return whether the device has a subscription, so the UI can show *push enabled* reliably.
- **Frontend change:** a `PushBackend` adapter with `capabilities.targetedDelivery = true`. `sendToUser`, the call dialog and messaging then work without other changes.
- **Current frontend behaviour:** because the backend does not have this, the frontend shows no "push enabled" badge (it is not reliably known) and returns `'unsupported'` from `sendToUser`.

## Data usage and bandwidth monitoring

The scope is the **current call**. It resets when a call starts and survives reconnects.

- **Source of truth per peer:** `RTCTransportStats.bytesSent` and `bytesReceived`. These count everything on the bundled transport: RTP, RTCP, DTLS and STUN. Where transport stats don't exist (Firefox), the app sums candidate-pair bytes instead. Each packet travels on exactly one pair, so the sum does not double-count.
- **One report per peer per tick:** the app never adds RTP-level bytes on top of transport bytes. `pc.getStats()` is a superset of `RTCRtpSender.getStats()` and `RTCRtpReceiver.getStats()`, so calling all of them would double-count.
- **Counter resets:** counters restart at 0 when an `RTCPeerConnection` is re-created. `DataUsageMonitor` accumulates positive deltas per `pcId`, so totals don't reset or double on a reconnect.
- **Displayed values:** My Upload (the sum across peers; in a mesh you upload to each peer separately), per-peer received, total received, and upload/download bitrate. Units are shown as KB/MB/GB and kbps/Mbps.

## Weak network handling

**Monitored metrics:** RTT, jitter, inbound and outbound packet loss, packets discarded, frames dropped, available outgoing and incoming bitrate, codec, quality limitation reason, and the selected pair.

**Quality classes:**

| Class | RTT | Loss | Jitter |
|---|---|---|---|
| Excellent | < 200 ms | < 2 % | < 40 ms |
| Good | < 400 ms | < 5 % | < 80 ms |
| Poor | < 800 ms | < 12 % | — |
| Critical | above that, or no bytes received for 3 samples | | |

RTT and loss are smoothed with an EWMA.

**Adaptation (`AdaptiveLadder`, in "Auto" mode):**

- Each peer has its own ladder: 180p → 360p → 480p → 720p. Each peer gets its own encoding, so one weak link does not degrade the others.
- **Down:** after 2 consecutive bad samples. Critical drops two steps.
- **Up:** only after 5 consecutive good samples, a minimum dwell of 8 s, and 1.3× bandwidth headroom for the next level.
- **Anti-oscillation:** an up-step followed quickly by a down-step doubles the up-cooldown, up to a maximum of 120 s.
- **Starting level:** depends on mesh size, because every extra peer costs another full upstream copy.
- **Mechanism:** changes are applied with `RTCRtpSender.setParameters()`, using `maxBitrate`, `scaleResolutionDownBy` and `maxFramerate`. There is never a renegotiation or a rebuilt connection.
- **Fixed presets:** Low, 360p, 480p, 720p and 1080p set fixed encodings and camera capture constraints.
- **Audio:** runs at a high sender priority. Audio bitrate presets are 16, 32 and 64 kbps.

## In-call chat, Picture-in-Picture and fullscreen

These features sit entirely in the UI and signaling layers. The ICE strategy, Perfect Negotiation, recovery logic and peer-connection lifecycle are unchanged.

### Chat

Chat goes over **ScaleDrone**, not a WebRTC DataChannel:

- Every participant is already subscribed to `mesh-<callId>`, so chat adds no subscription, no peer connection and no new failure mode to the media path.
- It also works for peers whose media is currently down (for example, a peer that is reconnecting).

Wire format: the standard signaling envelope with `messageType: "chat-message"` and `payload: { text }`. The envelope already carries `messageId`, `senderId`, `senderName`, `callId` and `timestamp`. `ChatService` maps it onto the domain type:

```ts
interface ChatMessage {
  type: 'chat-message';
  messageId: string;      // uuid, unique per message (a retry re-uses it)
  senderId: string;       // persistent deviceId
  senderName: string;
  receiverId?: string;    // unset = everyone in the call
  callId?: string;        // isolates the conversation
  text: string;           // trimmed, ≤ 2000 chars
  timestamp: number;
}
```

- **Isolation:** `ChatService` is bound to one `callId`. A message carrying any other `callId`, or arriving while no call is bound, is ignored. Chat is bound while the call is *connecting*, *connected* or *reconnecting*, so a WebRTC outage does **not** clear it. It is cleared once the call ends (messages, unread count and processed ids), so the next call always starts clean.
- **De-duplication and ordering:** `processedMessageIds` means each message is shown once. Messages are kept sorted by `(timestamp, messageId)`, so out-of-order arrival is fine. Ordering is by the sender's clock, so small clock skew between devices can reorder near-simultaneous messages.
- **Delivery:** our own message appears immediately as *Sending…*. It flips to sent when ScaleDrone echoes our publish back. With no echo within 12 s it becomes *Not delivered · Retry*. A retry uses the same `messageId`, so peers that already received it drop the duplicate.
- **Composer:**
  - **Enter** sends; **Shift+Enter** inserts a newline; IME composition is respected.
  - Empty or whitespace-only messages are not sent.
  - Identical text submitted twice within 0.8 s is treated as an accidental double send.
  - While signaling is down, input is disabled with the placeholder *Connecting…* or *Messaging unavailable*.
- **Unread count:** while the chat panel is closed, the **Chat** control shows a badge such as `Chat (2)`. Opening the chat clears it. Your own messages never count.
- **No history:** there is no backend. A participant who reloads starts with an empty chat, while the others keep theirs.

### Picture-in-Picture

- The **Enter PiP / Exit PiP** control, and a PiP button on each tile, use `HTMLVideoElement.requestPictureInPicture()` on the **existing tile `<video>`**. No second stream is created.
- **What PiP shows:** the *main participant*. That is the tile you clicked (outlined); otherwise a screen share, otherwise the first remote participant with video, otherwise your own video. Selecting another tile while PiP is open moves PiP to it.
- **If the PiP participant leaves:** PiP follows the new main participant if that tile has video; otherwise the browser closes it.
- **UI state is re-read from the browser:** `document.pictureInPictureElement` is checked on each `enterpictureinpicture` and `leavepictureinpicture` event. Closing the PiP window yourself therefore resets the button to *Enter PiP*.
- **Call end:** PiP is exited immediately.
- **States:** `inactive | entering | active | exiting | unsupported | error`.
- **Unsupported browsers:** the control is hidden, as in Firefox, which has only its own built-in PiP toggle.

### Fullscreen

- `requestFullscreen()` targets the **call container** (video area, chat panel and controls), never the whole app.
- In fullscreen the grid switches to a **spotlight** layout: the main participant is large and the others form a filmstrip.
- Clicking a filmstrip tile switches the main participant. The controls and chat stay usable.
- **ESC** exits; the browser handles it natively, and the `fullscreenchange` event resynchronises the UI.
- `fullscreenerror` shows a toast. Fullscreen is exited when the call ends.
- **States:** `inactive | active | unsupported | error`.
- **Fullscreen → PiP** and **PiP → Fullscreen** both work where the browser allows them. Button labels are always derived from the browser's current state, so they can't show a conflicting state.

### Layout

| Width | Chat / participants |
|---|---|
| Desktop (> 1100 px) | right-hand column inside the call view: Users · Video · Chat |
| Tablet (≤ 1100 px) | drawer over the video; controls stay visible; secondary controls move into **More** |
| Phone (≤ 767 px) | Video → Controls → Participants/Chat stacked; while typing, the video shrinks to a strip. The app height follows `visualViewport`, and `interactive-widget=resizes-content` keeps the on-screen keyboard from covering the input. |

Chat and participants share one panel with tabs. On desktop, all controls are inline: Mute, Camera, Share, Chat, People, Invite, Fullscreen, PiP, Stats and End. On smaller screens the primary controls stay inline (Mute, Camera, Chat, More, End) and the rest are in the **More** menu.

## Diagnostics: TURN, STUN and WebRTC debugging

Open the **Diagnostics** panel with the chart icon in the top bar.

**Per-peer diagnostics:**

- Connection State, ICE State, Signaling State, Gathering
- **Connection Type: P2P / STUN / TURN**
- **Candidate Pair: e.g. `host → host`**
- **Transport** (UDP/TCP, plus the relay protocol to the TURN server)
- **Path** (for example "Direct P2P (host / LAN)")
- Local and remote addresses
- relay-candidate gate state
- local and remote candidate counts by type
- time to connect, ICE restarts
- RTT, loss, jitter, bitrates, available bandwidth, codecs, resolution/fps, frames dropped
- ICE errors

A **Retry direct P2P** button forces an ICE restart for that peer.

### Exact connection path per participant

The path is read from `RTCPeerConnection.getStats()` of each peer connection, **never inferred from the configured ICE servers**:

1. The selected pair is `transport.selectedCandidatePairId`. Firefox falls back to `selected`, and other browsers to the busiest `nominated` + `succeeded` pair.
2. Its `local-candidate` and `remote-candidate` give the candidate types, addresses, protocol, `relayProtocol` and `url`.
3. The pair is classified as `ConnectionPath = 'p2p' | 'stun' | 'turn' | 'unknown'`:

| Selected pair | Path | Meaning |
|---|---|---|
| `host → host` (or `prflx` between private addresses) | **P2P** | direct, same network |
| `srflx`/`prflx` on either side, no relay | **STUN** | direct P2P through NAT; STUN only discovered the address, media does not pass through it |
| `relay` on either side | **TURN** | media relayed through a TURN server |
| not connected / no selected pair yet | **Unknown** | never guessed |

The actual pair is always shown, for example `relay → srflx`.

**Which STUN/TURN server?** It is only shown when WebRTC reports it:

- the `url` of the *local* candidate in `getStats()`, which Chrome exposes for srflx and relay candidates (verified in e2e: `turn:<host>:3479?transport=udp via stats`);
- otherwise, the `url` of the `icecandidate` event that gathered that exact candidate (matched by type, address, port and protocol).

If neither is available, the UI says *"Relay/Server-reflexive candidate detected – the browser did not say which server"* and lists the configured servers, without picking one. When only the **remote** side is relayed or reflexive, the peer's own server is not visible from this side, and the UI says so.

**Tiles:** the compact line shows `● Connected · P2P` (or Connecting / Reconnecting / Failed · Unknown). The ⓘ button expands the details: Connection, ICE, Protocol, RTT, Packet Loss, Upload, Download and the TURN/STUN server.

**Network Diagnostics** (in the Diagnostics panel) lists every peer connection with the same data. It reuses the single stats poll: one `getStats()` per peer connection every `stats.intervalMs` (2 s). The panel and tiles add no extra calls, as the e2e test verifies. The interval stays at 2 s because the adaptive-quality hysteresis is tuned to it.

### Network / ICE diagnostics: STUN and TURN tests

Each configured URL is listed under **STUN Tests** or **TURN Tests**, with its own **Test** or **Test TURN** button and a **Test all** button. Each test:

- creates a **temporary** `RTCPeerConnection` configured with that one server;
- adds a data channel and calls `setLocalDescription()` to gather candidates;
- **STUN** succeeds only if an **srflx** candidate is gathered, and shows the public address;
- **TURN** uses `iceTransportPolicy: 'relay'` **for this test connection only**. It succeeds only if a **relay** candidate is allocated, and shows the relay address, candidate protocol, relay protocol (UDP/TCP/TLS) and, when exposed, the reported URL. "Gathering completed" alone never counts as success;
- on failure, maps `icecandidateerror` codes to a cause: 401/403 → invalid credentials; 7xx → unreachable or DNS; 486/508; otherwise the list of possible causes (server unreachable, invalid credentials, incorrect port, server configuration, firewall, TLS/UDP/TCP issue);
- always closes the connection (freeing sockets and the TURN allocation) and times out after 8 s.

Results use `IceServerTestResult` (`src/webrtc/IceServerProbe.ts`). Normal calls always keep `iceTransportPolicy: 'all'`.

**ICE test modes** (Settings → Advanced) apply only to new connections and reset on reload:

- *Force TURN relay* uses `iceTransportPolicy: "relay"` and proves the relay path works.
- *Disable TURN* proves direct connectivity on its own.

**Console:**

- `window.__voip.diagnostics()` returns every peer's selected pair, `connectionPath`, identified `server`, transport and counters as JSON.
- `window.__voip.probeIceServers()` tests every configured server.
- `window.__voip.testIceServer({ urls, username, credential })` tests any single server. Set Settings → Log level to `DEBUG` for detailed structured logs, such as `[ICE] Selected candidate pair = host → host`.

**Browser tools:** use `chrome://webrtc-internals` in Chrome or `about:webrtc` in Firefox for a raw view.

## Configuration and security

| Variable | Purpose |
|---|---|
| `VITE_SCALEDRONE_CHANNEL_ID` | ScaleDrone channel |
| `VITE_STUN_SERVER` | comma-separated STUN URLs |
| `VITE_TURN_SERVER`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` | TURN relay |
| `VITE_DIRECT_P2P_TIMEOUT_MS` | P2P window before relay candidates are released (default 3000) |
| `VITE_HOST_ONLY_WINDOW_MS` | optional host-only head start (default 0) |
| `VITE_ICE_FALLBACK_MODE` | `gated` (default) or `native` |
| `VITE_RELAY_UPGRADE_PROBE_MS` | if > 0, periodically ICE-restart peers on relay to re-probe direct P2P |
| `VITE_PUSH_SERVER_URL`, `VITE_VAPID_PUBLIC_KEY` | Web Push relay |
| `VITE_LOG_LEVEL` | `ERROR` / `WARN` / `INFO` / `DEBUG` |

> ⚠️ **`VITE_*` variables are compiled into the JavaScript bundle and are public.** Anyone who opens the page can read the TURN username and credential. The values in `.env.example` are **development** credentials. In production, issue **short-lived TURN credentials** from a backend (the TURN REST API / coturn `use-auth-secret` HMAC scheme) and fetch them at runtime.

Other security notes:

- Credentials are never logged; the logger redacts `credential` and similar keys.
- Serve the app over HTTPS.
- ScaleDrone is used without JWT authentication here, so any client that knows the channel can publish, including spoofing a `senderId`. In production, enable ScaleDrone JWT authentication and put the push relay behind the same authentication.

## Browser limitations

- **Secure context:** camera, microphone, Service Worker and Push require HTTPS or localhost.
- **Hidden host IPs:** Chrome hides host IPs behind mDNS (`*.local`) until camera or microphone permission is granted. Receive-only viewers therefore expose only mDNS host candidates, which resolve on the same LAN only. A LAN `prflx` pair between private addresses is classified as P2P.
- **Autoplay policies** may block remote audio. A **Tap to enable audio** button appears when that happens.
- **Speaker selection** (`setSinkId`) is available in Chromium and Firefox 116+, not Safari.
- **Screen sharing** is desktop only.
- **Background throttling:** mobile browsers throttle or kill background tabs. The call recovers through ICE restart when the tab returns, but may drop if the OS kills the tab.
- **Picture-in-Picture:** available in Chromium (desktop and Android) and Safari. Firefox exposes no PiP API, so the control is hidden there.
- **Element fullscreen:** not available on iPhone Safari (`document.fullscreenEnabled` is false), so the control is hidden there. iPad Safari supports it.
- **Which STUN/TURN server was used:** the candidate `url` is non-standard in older specs. Chrome reports it for local srflx and relay candidates; Firefox and Safari may not. The UI then says so instead of guessing. The peer's server is never visible from this side.
- **Relay protocol** (`relayProtocol`) and `RTCPeerConnectionIceEvent.url` are not available in every browser; TURN tests fall back to the transport requested by the URL.
- **`icecandidateerror`** codes vary: Chrome reports 401 for bad TURN credentials and 701 for unreachable servers. Other browsers may report nothing, so the test only says "no relay candidate" with the possible causes.
- **Web Push on iOS** requires the app to be installed to the Home Screen. A Service Worker can never run a call.
- **`navigator.connection`** (the Network Information API) exists only in Chromium, so network-change detection falls back to online/offline events, sleep detection and signaling liveness elsewhere.

## Mesh scalability limitations

With N participants, every client encodes and uploads **N−1 streams** and decodes N−1 streams:

| Participants | Upload per client at 720p (~1.6 Mbps each) |
|---|---|
| 2 | 1.6 Mbps |
| 4 | 4.8 Mbps |
| 6 | 8.0 Mbps |

"Auto" quality lowers the starting resolution as the mesh grows. The group cap is 6 and the live viewer cap is 8. Beyond roughly 4–6 video participants, or a handful of viewers, an SFU is the right architecture. This project deliberately does not include one.

## Testing

```bash
npm test                       # unit tests (candidate gate, path classification, stats parsing,
                               #   data usage, hysteresis, recovery re-entrancy, state machine…)
npm run dev &                  # then, with a real ScaleDrone channel:
npm run test:e2e               # two/three-browser end-to-end suite (headless Chrome, fake media)
npm run test:resilience        # glare, offline→online, signaling reconnect, peer vanishes
npm run test:screens           # responsive screenshots → tests/e2e/artifacts/
npm run test:features          # PiP, fullscreen, chat (1:1 + group), combined states, mobile layout
npm run test:rooms             # rooms & isolation, 5 layouts × 3 viewports, 1:1→group, live audience control
npm run test:pwa               # SW, installability, offline shell, update flow (run `npx vite build --base=/meshcall/` first)
npm run test:diagnostics       # connection path/server on tiles + panel, STUN/TURN tests, offline users,
                               #   DMs (online → Delivered, offline → queued, never /notifyAll), notification click
                               #   (needs the local TURN setup below; TURN_HOST=<LAN-IP>)
npm run test:room-persistence  # active room reopened on launch, cleared by Leave, switching saves the new room
npm run test:live-call         # streamer calls someone into a live stream: ringing invite, targeted push, re-ring online
npm run test:push              # Web Push against the real backend – needs `npx vite --base=/meshcall/ --port 5173`
                               #  (never calls /notifyAll; removes every test subscription afterwards)
```

The e2e suite checks:

- presence
- 1:1 video with **direct P2P selected**
- media flowing
- ICE restart on network change
- **rejoin creates a new connection and tries P2P again**
- hangup cleanup (camera, microphone and peer connections released)
- reject
- STUN reachability
- **forced TURN relay (relay → relay) with media flowing**
- **the next call after a TURN call goes direct again**
- a three-way group mesh
- leave and rejoin in a group
- live streaming with two viewers
- stream-ended handling

To exercise the relay path locally without an external TURN server, run a throwaway TURN server:

```bash
node tests/e2e/local-turn.mjs &                               # UDP 3479, user e2e / e2e-secret
VITE_TURN_SERVER=turn:<LAN-IP>:3479 VITE_TURN_USERNAME=e2e VITE_TURN_CREDENTIAL=e2e-secret \
  npx vite --port 5174 &
E2E_URL=http://localhost:5174/ npm run test:e2e
```

These scenarios need real devices or networks and are not automated: Wi-Fi ↔ hotspot switching, genuine NAT and firewall fallback, 3G throttling, push delivery to a closed browser, and permission denial. Use Chrome DevTools network throttling, `chrome://webrtc-internals`, and the Diagnostics panel for manual verification.

---

## Developer guide: how calls and peers are connected

This section is written for anyone (human or AI agent) who needs to **refactor the calling stack or plug in a different VoIP implementation** without breaking the existing app. It follows the code path of a call from the button press to media on screen, names every function involved, and lists the contracts and invariants each layer relies on. File paths are relative to `src/`.

### 1. Layers and ownership

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ UI (ui/UIManager, ui/views/CallView, VideoGrid, Dialogs…)                    │
│   reads CallState + MediaStreams, calls CallManager / LiveStreamManager      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Call control    calls/CallManager.ts        invite/ring/accept/reject/hangup │
│                 calls/CallStateMachine.ts   allowed status transitions       │
│                 calls/LiveStreamManager.ts  go live, discovery, audience     │
│                 calls/InviteManager.ts      open invites (drop-in group)     │
│                 calls/GroupCallManager.ts   thin facade over CallManager     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Membership      calls/MeshSession.ts        who is in THIS call, access rules│
│                                             join/welcome/heartbeat/leave      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Peer links      webrtc/PeerConnectionManager.ts  one PeerSession per remote  │
│                 webrtc/PeerSession.ts       one RTCPeerConnection, Perfect   │
│                                             Negotiation, ICE queueing        │
│                 webrtc/IceStrategy.ts       CandidateGate (P2P window)       │
│                 webrtc/ConnectionRecoveryManager.ts  ICE restart / recreate  │
│                 webrtc/WebRTCManager.ts     RTCConfiguration factory         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Local media     media/MediaManager.ts       getUserMedia, mute, screen, swap │
├──────────────────────────────────────────────────────────────────────────────┤
│ Transport       services/SignalingService.ts  ScaleDrone pub/sub, envelopes, │
│                                             dedupe, outbox, liveness         │
└──────────────────────────────────────────────────────────────────────────────┘
```

Rules that hold across all layers:

- **Downward calls, upward events.** A layer calls methods on the layer below and listens to its `events` (`core/emitter.ts`, a typed `Emitter`). Nothing below the UI touches the DOM.
- **Everything is created once in `app.ts` (`createApp`)** and injected explicitly. There are no singletons inside the calling stack (only `ui/BackStack` is a UI singleton).
- **One call at a time.** `CallManager` holds at most one `CallState` and one `MeshSession`. A *call*, a *group call* and a *live stream* are all the same object with a different `kind`.
- **A 1:1 call is a mesh of two.** There is no separate 1:1 media path; `MeshSession` handles every kind, and only its access rules and transceiver directions differ.

### 2. Identifiers (get these right and everything else follows)

| Id | Created by | Lifetime | Used for |
|---|---|---|---|
| `deviceId` | `IdentityService` (localStorage) | permanent per browser profile | user identity, inbox address, `senderId`/`receiverId`, presence key |
| `sessionId` | `IdentityService` (per page load) | one page load | detects reloads (= rejoin), `receiverSessionId` targeting, politeness tie-break |
| `roomId` / `roomKey` | `RoomService` (normalised name / short hash) | while in the room | message scoping (`roomId` on every envelope), ScaleDrone room names |
| `callId` | `uuid()` in `CallManager` (`streamId` for live) | one call/stream | `mesh-<callId>` room, `callId` on every call message, push payloads, history |
| `pcId` | `uuid()` per `PeerSession` | one `RTCPeerConnection` | negotiation routing (`pcId` / `targetPcId`), stale-message rejection, orphan detection |
| `messageId` | `uuid()` per envelope (or reused for retries) | one message | de-duplication (`BoundedSet` of 4000) |

**Politeness** (`isPolite` in `webrtc/PeerConnectionManager.ts`): `"${myDeviceId}|${mySessionId}" > "${theirDeviceId}|${theirSessionId}"` → I am polite. The **impolite** side (the smaller string) creates the connection and sends the first offer. Because the session is part of the key, a reload can flip roles; that is intended, since a reload always builds a fresh connection.

### 3. Transport: what a message goes through

**Sending** (`SignalingService`):

- `send(receiverId, type, payload, {callId, peerId, receiverSessionId, messageId})` publishes a *directed* envelope to `inbox-<roomKey>-<receiverId>`.
- `broadcast(roomName, type, payload, opts)` publishes to any room (`mesh-<callId>`, `observable-room-<roomKey>`), with `receiverId: '*'`.
- `envelope()` stamps `v`, `messageId`, `timestamp`, `senderId`, `senderSessionId`, `senderName`, `roomId`, `callId`, `peerId`.
- While disconnected, messages go to an outbox (max 300, dropped after 20 s) and are flushed on reconnect.

**Receiving**: each incoming ScaleDrone message passes these filters **in this order**, and is dropped at the first that fails:

1. `isSignalingMessage()`: structural validation and the protocol version `v === 2`.
2. Our own session (`senderSessionId === mine`): this is the echo the liveness watchdog waits for; it is never emitted as a message.
3. A different `roomId` from the current room scope.
4. `receiverId` is neither `'*'` nor my `deviceId`.
5. `receiverSessionId` is set and is not my `sessionId` (lets a reply reach only the tab that asked).
6. Already-seen `messageId`.

Survivors are emitted as `signaling.events 'message'`. Listeners:

- `CallManager.onMessage`: call-control types (`call-*`, `call-participants-added`) are handled there. **Every other message whose `callId` equals the current mesh's `callId` is forwarded to `MeshSession.handleMessage`.**
- `PresenceService`, `LiveStreamManager`, `ChatService`, `DirectMessageService` each pick their own types.

ScaleDrone rooms subscribed (`SignalingService.subscribe(name, handlers)` survives client re-creation):

| Room | Subscribed by | When |
|---|---|---|
| `observable-room-<roomKey>` | `PresenceService.start` | joining a room (`joinRoom` in `app.ts`) |
| `inbox-<roomKey>-<myDeviceId>` | `CallManager.start` | joining a room |
| `mesh-<callId>` | `MeshSession.join` | entering a call/stream; unsubscribed in `MeshSession.leave` |

### 4. Message catalogue (calling-related)

| Type | Channel | From → To | Handled in | Effect |
|---|---|---|---|---|
| `call-invite` | inbox | caller/host → invitee | `CallManager.onInvite` | creates incoming `CallState` (`ringing`), replies `call-ringing`, rings, shows notification; replies `call-reject{busy}` if in a call; ignores expired (`expiresAt` + 60 s skew) |
| `call-ringing` | inbox | invitee → caller | `onRinging` | caller `calling → ringing`; marks a group invite as acked |
| `call-accept` | inbox | invitee → caller | `onAccept` | 1:1: caller sends `call-cancel{answered-elsewhere}` to the callee's other tabs, goes `connecting`, `startMesh()`. Group: clears the pending invite and widens the allow-list. Unknown call: replies `call-hangup{ended}` |
| `call-reject` | inbox | invitee → caller | `onReject` | 1:1 → `busy` / `rejected`; group → toast |
| `call-cancel` | inbox | caller → invitee | `onCancel` | stops ringing (missed call / answered elsewhere) |
| `call-hangup` | inbox | either → other (1:1) | `onHangup` | ends the 1:1 call |
| `call-participants-added` | mesh | participant → all | `onParticipantsAdded` | 1:1 → group conversion, allow-list widened |
| `mesh-join` | mesh | joiner → all | `MeshSession.onMember` | access check, upsert participant, reply `mesh-welcome`, impolite side connects |
| `mesh-welcome` | inbox | member → joiner | `onMember` | joiner learns existing members; impolite side connects |
| `mesh-heartbeat` | mesh | everyone, every 10 s | `onMember` | heals missed joins; carries `peers{remoteId→pcId}` for orphan detection |
| `mesh-leave` | mesh | leaver → all | `onLeave` | closes only that participant's connection |
| `mesh-remove` | mesh | host → all | `onRemove` | target leaves; others ban and drop it |
| `mesh-reject` | inbox | authoritative member → joiner | `handleMessage` | joiner fails with *full* / *not allowed* (ignored unless sent by the host for group/live) |
| `media-state` | mesh | participant → all | `handleMessage` | mute/camera/screen icons (debounced 150 ms) |
| `offer` / `answer` / `ice-candidate` | inbox | peer → peer | `PeerConnectionManager.handleNegotiation` → `PeerSession.process` | SDP/ICE, routed by `pcId`/`targetPcId` |
| `peer-reconnect` | inbox | peer → peer | `PeerSession.process` | informational: the remote re-created its connection |
| `live-*` | lobby / inbox | streamer ↔ viewers | `LiveStreamManager` | discovery, audience, ringing invite into a stream |
| `invite-started` | lobby | initiator → room, every 10 s | `InviteManager.onMessage` | lists the open invite for invited users, toast with Join, re-applies the call's access list |
| `invite-stopped` | lobby | initiator → room | `InviteManager.onMessage` | removes the invite; terminates the call for anyone in it |

All payload shapes are in `types/signaling.ts`.

### 5. End-to-end trace: a 1:1 video call

Caller **A**, callee **B**, both already in the same room (`joinRoom` done, inbox subscribed).

**A presses "Video call"** → `UIManager.callUser` → `CallManager.startDirectCall(B, 'video')`:

1. `guardIdle()` refuses if already in a call or signaling is down.
2. `newCall({status:'calling', direction:'outgoing', kind:'direct'})`, `remoteUser = B`, then `emit()`, so the UI shows "Calling…".
3. `acquireMedia('video')` → `MediaManager.acquire()` (getUserMedia). The local preview is `media.stream`.
4. `sendInvite(B, 'direct')` sends `call-invite` to B's inbox with `expiresAt = now + ringMs`.
5. Outgoing ringtone starts, and presence goes `busy`.
6. If B is not online: `sendPush(B)` → `PushNotificationService.notifyIncomingCall` (targeted `POST /notify`, never broadcast).
7. Timers start: `noAckTimer` (8 s, then push or fail) and `ringTimer` (45 s, then `call-cancel{timeout}` and "No answer").

**B receives `call-invite`** → `onInvite`:

1. Validates the invite (duplicate / expired / busy) and records `inviteSender = {deviceId: A, sessionId: A's}`.
2. Creates `CallState{status:'ringing', direction:'incoming'}`.
3. Replies `call-ringing` with `receiverSessionId` = A's session.
4. Starts the ringtone and system notification, and a ring timeout of 50 s.

**A receives `call-ringing`** → `calling → ringing`.

**B presses Accept** → `acceptIncoming()`:

1. `setStatus('connecting')` and `acquireMedia`.
2. Sends `call-accept` to A's session, then re-sends it every 3 s (max 5) until A shows up in the mesh.
3. `startMesh()`.

**A receives `call-accept`** → `onAccept`:

1. Stops ringing and sends `call-cancel{answered-elsewhere, answeredBySessionId}` so B's other tabs stop ringing.
2. Goes `connecting`, then `startMesh()`.

**`startMesh()`** (both sides) builds the `MeshSession`:

- **Options:** `allowList = [A, B]` (1:1), `role 'participant'`.
- **Event wiring:** `participants` → `recomputeStatus`, plus `left`, `removed`, `rejected` and `stats`.
- **Join:** calls `mesh.join()`.
- **Timeout:** starts `connectTimer` (25 s, after which the call fails with "Could not establish a connection").

**`MeshSession.join()`**:

1. Subscribes to `mesh-<callId>`. On open it broadcasts `mesh-join` with `{role, callKind, media, peers, hostId}`.
2. Starts the 10 s heartbeat, `StatsMonitor` (2 s) and active-speaker detection.
3. Wires media events: `media 'track'` → `peers.replaceTrack`, and `media 'state'` → `media-state` broadcast.

**Each side receives the other's `mesh-join`** (or the `mesh-welcome` sent in reply) → `onMember`:

1. Runs the access check `allowed()`, then `upsert` of the participant.
2. On a `mesh-join` it replies `mesh-welcome` (directed).
3. **If there is no `PeerSession` for that device and I am impolite** → `peers.connectAsOfferer(remote)`. The polite side does nothing and waits for the offer.

**Impolite side** → `PeerConnectionManager.create()` → `new PeerSession(...)`:

1. `WebRTCManager.createPeerConnection()` with `iceTransportPolicy:'all'`, `bundlePolicy:'max-bundle'`, `rtcpMuxPolicy:'require'` and `iceCandidatePoolSize:2`.
2. A `CandidateGate` is created for the P2P window, and handlers are wired (`wire()`).
3. `startAsOfferer()` calls `addTransceiver(track ?? kind, {direction, streams:[media.stream]})` for `audio` and `video`. Both transceivers always exist, even without a track, so turning the camera on later never renegotiates.
4. `negotiationneeded` → `negotiate()` → `setLocalDescription()` → `sendOffer()` sends `offer{description, pcId, targetPcId:null, iceRestart}` to the peer's inbox with `receiverSessionId`.
5. A negotiation watchdog starts: 10 s → re-send (×2) → `stalled` → `ConnectionRecoveryManager` re-creates.

**Polite side receives `offer`** → `MeshSession.handleMessage`, `isNegotiationMessage`:

1. The access check is repeated (`allowed`, `shouldConnect`), and the participant is upserted if needed.
2. `PeerConnectionManager.handleNegotiation`:
   - drops messages from **retired** remote `pcId`s;
   - session changed / new remote `pcId` with an offer → closes the old session and makes a fresh one;
   - a candidate with no session yet → **parked** as an orphan (30 s TTL) and replayed later.
3. No session → `create(remote)` (polite), then `session.handleSignal(msg)` → `SerialQueue` → `process()`.
4. `handleDescription()` runs Perfect Negotiation (collision checks), `setRemoteDescription`, records `remotePcId`, then `attachLocalMedia()` (binds our tracks to the transceivers the offer created and sets their direction).
5. `setLocalDescription()` → sends `answer{pcId, targetPcId: offerer's pcId}`, then `flushPending()` applies candidates that arrived early.

**Offerer receives `answer`** → `handleDescription` → `setRemoteDescription`; the watchdog is cleared and pending candidates are flushed.

**ICE** (both sides, in parallel with the above):

1. `onicecandidate` → `CandidateGate.offer()`.
2. Host and srflx candidates are sent immediately as `ice-candidate{candidate, pcId, targetPcId}`. Relay candidates are **held** until a direct path connects (then sent as standby), 3 s pass, ICE fails, or gathering ends with no direct candidate.
3. The receiver's `handleRemoteCandidate` queues candidates by `pcId` if they arrive before the SDP or carry a different ICE ufrag (an ICE restart in flight). It de-duplicates and calls `addIceCandidate`; errors are swallowed.

**Media arrives**: `ontrack` → the track is added to `PeerConnectionManager.remoteStream(remoteDeviceId)`.

- That is **one `MediaStream` per remote device, kept across re-creations**, so a reconnect never replaces the stream object the UI holds.
- `PeerSession` emits `track` → `peerTrack` → `MeshSession 'participants'`.

**Connected**:

1. `onconnectionstatechange('connected')` → `patchState` → `peerState` event.
2. `MeshSession` copies the state into `ParticipantState.peer` and applies encodings (`AdaptiveQualityManager.applyTo`).
3. `CallManager.recomputeStatus()` sees a connected peer → `setStatus('connected')`, stamps `connectedAt`, and clears `connectTimer`.

**UI**: `CallView` renders a tile per participant:

- remote tiles use `session.remoteStream(deviceId)`, the local tile `app.media.stream`;
- the connection path badge comes from `StatsMonitor` (`getStats()` selected pair, never from config).

**Hang-up** → `CallManager.hangup()` → `finish('ended')`:

1. Sends `call-hangup` to the remote's accepted session (1:1).
2. `teardown()` clears timers, stops the ringtone, calls `mesh.leave()` (broadcasts `mesh-leave`, then disposes recovery, stats and every `PeerSession`, and unsubscribes `mesh-<callId>`), then `media.release()` (stops camera and mic), sets presence not busy, and clears the saved call.
3. The status goes `ended` and the ended screen shows for 2.5 s → `reset()` → `CallState = null`.

### 6. How group calls, open invites and live streams differ

Group, open-invite and live calls use the same pipeline; only these knobs change (all set in `CallManager.startMesh` / `MeshSession`):

| | 1:1 (`direct`) | Group (`group`) | Open invite (`group`) | Live: broadcaster | Live: viewer |
|---|---|---|---|---|---|
| Call-control handshake | invite → ringing → accept | host invites each user; invitee accepts | none: lobby announcement + Join (`joinInvite`) | none (`startLive`) | none (`joinLive`) |
| Status after `startMesh` | `connecting` until a peer connects | `connected` immediately ("Waiting for participants") | same as group | `connected` ("Live – waiting for viewers") | `connecting` until the broadcaster connects |
| Access rule (`allowed`) | `allowList = [me, them]` | allow-list plus *vouched* joiners (`invitedBy` on the list) plus welcomes | `[initiator, ...allowedIds]`, or open (`null`) for *Everyone* (`setAccess`) | `authorize(deviceId)` callback = audience | only `hostId` |
| Who connects to whom (`shouldConnect`) | both | everyone ↔ everyone | everyone ↔ everyone | ↔ viewers only | ↔ broadcaster only |
| `PeerConnectionManager {send, receive}` | true / true | true / true | true / true | true / false (`sendonly`) | false / true (`recvonly`) |
| Caps | 2 | `mesh.maxParticipants` = 6 (host rejects `full`) | same as group (initiator rejects while in the call) | `mesh.maxLiveViewers` = 8 | n/a |
| Ends when | the other side leaves or hangs up | you leave (others leaving just drops tiles) | for you: you leave (rejoin any time); for everyone: initiator ends the invite (`invite-stopped`) | you stop | the broadcaster leaves → "Stream ended" |

**1:1 → group conversion:**

1. `addParticipants()` broadcasts `call-participants-added`, then `mesh.allow()`, then `call-invite{group}` to each new user.
2. Every client calls `convertToGroup()`, which changes **metadata and access policy only**. The existing `RTCPeerConnection` is never touched; only new links are negotiated.

**Open invites (drop-in group calls)** (`calls/InviteManager.ts`):

- **Open:** the initiator opens an invite for everyone or for selected people. It is announced in the lobby as `invite-started` (payload `OpenInviteInfo`, re-sent every 10 s) and closed with `invite-stopped`. Only the initiator's own messages are accepted for an invite.
- **The call:** a plain group mesh with `callId = inviteId`, started through `CallManager.joinInvite()`. There is no invite, ring or accept handshake: joining is just `mesh-join`.
- **Leave and rejoin:** leaving is a normal group leave (`mesh-leave`), so people can leave and rejoin any number of times.
- **Access:**
  - every participant's `MeshSession` allow-list is `[initiator, ...selected]`, or open for *everyone*;
  - it is re-applied from each announcement through `MeshSession.setAccess()`;
  - non-invited users never list the invite, and their joins are rejected.
- **Ending:**
  - the initiator ending the invite (or leaving the room) terminates the call for everyone;
  - if the initiator only leaves the call, the invite stays open;
  - the initiator's invite survives a reload (sessionStorage);
  - if the initiator closes the app, the invite expires 35 s after the last announcement.

### 7. Local media contract

`PeerSession` depends only on the `LocalMediaSource` interface (`webrtc/PeerSession.ts`):

```ts
interface LocalMediaSource {
  readonly stream: MediaStream;                              // used for addTransceiver({streams}) / setStreams
  getSendTrack(kind: 'audio' | 'video'): MediaStreamTrack | null; // what to send right now
}
```

`MediaManager` implements it:

- `getSendTrack('video')` returns the screen track while sharing, otherwise `null` while the camera is off, otherwise the camera or effects track.
- Every change emits `media.events 'track' {kind, track}`, and `MeshSession` reacts with `PeerConnectionManager.replaceTrack()`, which calls `RTCRtpSender.replaceTrack` on every peer.
- **This covers mute, camera on/off, device switch, camera flip, screen share and effects, with no renegotiation.**
- Audio mute uses `track.enabled = false`.

Bitrate, resolution and frame rate are changed with `RTCRtpSender.setParameters`:

- calls go through `PeerSession.setEncoding`, driven by `AdaptiveQualityManager`;
- the desired values are remembered and re-applied after every reconnect.

### 8. Recovery: who fixes what

| Problem | Detected by | Fix |
|---|---|---|
| ICE `disconnected` | `ConnectionRecoveryManager.onPeerState` | 3 s grace → `PeerSession.restartIce()` |
| ICE `failed` | same | immediate ICE restart; after 3 restarts → `connectAsOfferer` (new `RTCPeerConnection`, new `pcId`, `peer-reconnect` sent); circuit breaker at 4 re-creations per peer per minute |
| Offer or answer lost | `PeerSession` negotiation watchdog | re-send the offer twice → `stalled` → re-create |
| Remote reloaded (new `sessionId`) | `MeshSession.onMember` / `handleNegotiation` | close the old session and keep the remote stream object; a fresh connection is built |
| Remote re-created its PC (new `pcId` in an offer) | `PeerConnectionManager.handleNegotiation` | close the old session and answer on a fresh one |
| One-sided connection (remote doesn't know our `pcId`) | heartbeat `peers` map in `onMember` | impolite side re-creates |
| Network change or wake from sleep | `NetworkMonitor` → `CallManager` → `mesh.onNetworkChange` | ICE restart on every peer (the P2P window is re-armed) |
| Signaling socket dead | `SignalingService` echo watchdog | re-create the ScaleDrone client → `reconnected` → `mesh-join` re-announce plus restart of unhealthy peers |
| Participant silent and media dead | `MeshSession.tick` (35 s) | drop that participant only |
| 1:1 peer stays disconnected | `CallManager.recomputeStatus` | `reconnecting` → `failed` after 45 s |

### 9. What the UI consumes (the public surface)

If you rewrite the transport or the WebRTC layer, keep this surface and the UI keeps working:

- **`app.calls` (`CallManager`)**
  - **Methods:**
    - `startDirectCall(userId, media)`, `startGroupCall(ids, media, name?)`
    - `acceptIncoming()`, `rejectIncoming()`, `hangup()`
    - `addParticipants(ids)`, `removeParticipant(id)`
    - `toggleMute()`, `toggleCamera()`, `toggleScreenShare()`
    - `rejoin(saved)`, `retryDirect(id)`
  - **Getters:** `state`, `session` (the `MeshSession`), `inCall`, `pendingInviteIds`, `rejoinOffer`.
  - **Events:**
    - `state` (`CallState | null`, emitted on every change)
    - `toast`
    - `stats` (`{report, usage}`)
    - `rejoinAvailable`
- **`app.calls.session` (`MeshSession`):**
  - `remoteStream(deviceId)` (a stable `MediaStream`), `participants` (`Map<deviceId, ParticipantState>`), `statsReport`;
  - events `activeSpeaker` and `peerState`.
- **`app.media` (`MediaManager`):** `stream` (local preview), `state`, the `state` event, and device and quality methods.
- **`app.live` (`LiveStreamManager`):**
  - `goLive`, `join`, `watch`, `callViewer`, `updateAudience`;
  - events `streams`, `state`, `invite`.
- **`app.invites` (`InviteManager`):**
  - `startInvite(title, media, {mode, ids})`, `join(inviteId)`, `endInvite()`;
  - `list()`, `hostedInvite`, `isIn(inviteId)`, `isHostOf(callId)`, `canJoin(inv)`;
  - events `change` (the list), `new` (an invite for us appeared), `hostLeft` (the initiator left their own invite's call).
- **Data shapes:** `CallState`, `ParticipantState` and `PeerConnectionState` in `types/state.ts`. Status transitions must stay valid per `CallStateMachine.ts`, because the UI and call history (`CallHistoryService.callOutcome`) classify calls from `status` + `statusDetail` + `connectedAt`.

### 10. Invariants you must keep

1. **Validate access on every negotiation message, not just on join.** Media must never be negotiated with an unauthorised device (`MeshSession.allowed` + `shouldConnect`). Hiding a tile is not protection.
2. **Exactly one side sends the first offer** (the impolite one). Perfect Negotiation handles any later collision; don't add a second "initial offer" path.
3. **Every negotiation message carries `pcId` and `targetPcId`.** Without them a late answer or candidate from an old connection would corrupt a new one.
4. **Never assume `pc.connectionState` means the call is good.** The call status is derived (`recomputeStatus`). Signaling down ≠ call down, and media can flow without signaling.
5. **Remote `MediaStream` objects are stable per device.** Add and remove tracks on them; never hand the UI a new stream on reconnect.
6. **Never cache "needs TURN".** Every new connection, ICE restart and rejoin starts direct-first (the `CandidateGate` is re-armed per ICE generation).
7. **Everything that waits has a timeout** (ring, no-ack, accept→connect, negotiation, reconnect). Add one for any new waiting state.
8. **Push is targeted only** (`POST /notify` for one `deviceId`). Never `/notifyAll` for calls or messages.
9. **Secrets never enter the bundle.** TURN credentials come from `VITE_*` build variables (which are public by nature); the VAPID private key stays on the push server.
10. **Teardown releases everything:** peer connections, the mesh room subscription, timers, camera and microphone (`CallManager.teardown`). The e2e hang-up test checks that camera, microphone and peer connections are released.

### 11. Recipes

**Replace ScaleDrone with another signaling transport** (WebSocket server, Firebase, MQTT, Socket.IO…):

- Re-implement `SignalingService` with the same public API:
  - `subscribe(roomName, {onOpen, onMembers, onMemberJoin, onMemberLeave})` returning an unsubscribe function;
  - `send(...)`, `broadcast(...)`, `setRoom(...)`, `start()`, `stop()`, `reconnectNow()`;
  - `status` / `isConnected` / `currentRoom`;
  - events `status`, `message`, `reconnected`, `echo`.
- Keep `envelope()` and the six receive filters exactly. The rest of the app relies on de-duplication, room scoping and `receiverSessionId`.
- Room semantics to reproduce:
  - **inbox** = point-to-point;
  - **mesh / lobby** = fan-out;
  - **presence lobby** = a member list with join/leave events (`PresenceService` uses `onMembers` / `onMemberJoin` / `onMemberLeave`).
- If your server does not echo publishes back to the sender, replace the echo watchdog with ping/pong.

**Replace the mesh with an SFU** (LiveKit, mediasoup, Janus…):

- Keep `CallManager` (invite / ring / accept, state machine, push, history) and replace what `startMesh()` creates.
- Write an `SfuSession` with the same surface `CallManager` and the UI use from `MeshSession`:
  - methods `join()`, `leave(reason)`, `handleMessage(msg)`, `allow(ids)`, `convertToGroup(ids)`, `removeParticipant(id)`, `onNetworkChange(reason)`, `retryDirect(id)`, `remoteStream(deviceId)`;
  - members `participants`, `callId`, `statsReport`;
  - events `participants`, `left`, `removed`, `rejected`, `stats`, `activeSpeaker`, `peerState`, `converted`.
- Map SFU participants to `ParticipantState`, using `deviceId` as the participant identity so presence and history still match.
- `PeerConnectionState` can describe your single SFU transport.
- `mesh.maxParticipants` / `maxLiveViewers` then become SFU limits.

**Interoperate with a native or other client:** implement the wire protocol in `types/signaling.ts`:

- envelope `v: 2`;
- ScaleDrone room names from §3;
- transceiver order `audio`, then `video`, with `max-bundle`;
- the politeness rule from §2;
- `mesh-join` on entering `mesh-<callId>` and a heartbeat every ≤10 s;
- answer `mesh-join` with `mesh-welcome`.

A client that skips heartbeats is dropped after 35 s once its media dies.

**Add a new signaling message:**

1. Add the type to the `SignalingMessage` union **and** to the `TYPES` set in `types/signaling.ts` (unknown types are rejected by `isSignalingMessage`).
2. Send it with `signaling.send` / `broadcast`, and pass `callId` if it belongs to a call.
3. Handle it:
   - call-level messages: add a `case` in `CallManager.onMessage`;
   - mesh-level messages: add a `case` in `MeshSession.handleMessage`;
   - otherwise: listen on `signaling.events 'message'` in your own service.

**Add a DataChannel** (file transfer, reactions…):

- Create it in `PeerSession.startAsOfferer()` (before the offer, so it is in the first SDP) and listen to `pc.ondatachannel` in `wire()`.
- Expose it through `PeerConnectionManager`, and treat it as per-`pcId`: it is replaced whenever the connection is re-created.
- In-call chat deliberately does **not** use a DataChannel. It rides on `mesh-<callId>` so it survives media failures.

**Change STUN/TURN or the P2P policy:**

- Servers come from `VITE_STUN_SERVER` / `VITE_TURN_*` (`config.ts`, `buildIceServers`, `orderStunUrls`).
- The P2P window comes from `VITE_DIRECT_P2P_TIMEOUT_MS`; `VITE_ICE_FALLBACK_MODE=native` disables the gate.
- Diagnostic modes `relay-only` / `no-relay` are set in Settings → Call → Connection (`WebRTCManager.buildConfiguration`).

### 12. Where to change X

| I want to… | Look at |
|---|---|
| change ring/connect/reconnect timeouts or mesh caps | `config.ts` (`timeouts`, `mesh`) |
| change call status rules | `calls/CallStateMachine.ts`, `CallManager.setStatus/finish/recomputeStatus` |
| change who may join or see media | `MeshSession.allowed`, `shouldConnect`; live audience: `LiveStreamManager.isAllowed`; open invites: `InviteManager.accessOf` / `MeshSession.setAccess` |
| change open invites (announce interval, expiry, end rules) | `calls/InviteManager.ts` (`ANNOUNCE_MS`, `EXPIRE_MS`), `CallManager.joinInvite`; UI: `Sidebar.renderInvites`, `Dialogs.openStartInvite`, `UIManager.endInvite` |
| change SDP/ICE handling | `webrtc/PeerSession.ts` (`negotiate`, `handleDescription`, `handleRemoteCandidate`) |
| change when TURN is used | `webrtc/IceStrategy.ts` (`CandidateGate`), `config.ice` |
| change recovery behaviour | `webrtc/ConnectionRecoveryManager.ts` |
| change bitrate/resolution adaptation | `webrtc/AdaptiveQualityManager.ts`, `AdaptiveLadder.ts`, `media/QualityPresets.ts` |
| change camera/mic capture or effects | `media/MediaManager.ts`, `media/VideoEffects.ts` |
| change speaker / earpiece / volume boost | `media/AudioRoute.ts`, `ui/views/VideoGrid.ts` (`update`, remote-audio block) |
| change offline call push | `CallManager.sendPush`, `services/PushNotificationService.ts`, `push/PushBackend.ts`, `public/sw.js` |
| change what the call screen shows | `ui/views/CallView.ts`, `VideoGrid.ts`, `ui/layout/CallLayoutManager.ts` |
| read the logs of a real call | browser console: tags `[Call] [Mesh] [WebRTC] [ICE] [Recovery] [Signaling]`; Diagnostics panel; `chrome://webrtc-internals` |
