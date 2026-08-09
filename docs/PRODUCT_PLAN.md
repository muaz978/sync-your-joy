# Product plan

## 1. Product promise

SyncYourJoy lets two or more people watch the same title together while each person streams from their own account and device. One authoritative controller drives playback for the room, and the system continuously detects and corrects drift.

The public promise should be **tight, reliable synchronization**, not “zero latency.” A networked product cannot eliminate propagation delay, browser scheduling, buffering, or differences between streaming players. What the product can guarantee is ordered control, one authoritative room state, explicit readiness, automatic recovery, and measurable service objectives.

### Initial service objectives

Under a healthy connection (round-trip time at or below 200 ms and no participant buffering):

- 95% of pause commands applied remotely within 250 ms;
- 95% of participants within 250 ms of the authoritative timeline during steady playback;
- every accepted control command assigned one monotonic room revision and applied at most once;
- mismatched titles or episodes never auto-played without a visible warning;
- room state recovered automatically after a transient disconnect.

These are launch hypotheses. Instrumented tests must validate or revise them before they become marketing claims.

## 2. Recommended experience

### Surfaces

Use two complementary surfaces:

1. **In-page sync pill** — a small floating element near, but not inside, the streaming service's proprietary controls. It shows connection state, room state, participant count, and whether the viewer is in sync. The host gets play/pause and a shortcut to the full panel. A Shadow DOM boundary prevents site CSS collisions.
2. **Chrome side panel** — the durable home for room creation, joining, invite sharing, participant readiness, host transfer, buffering status, settings, and troubleshooting. It remains useful across navigation and does not cover the video.

Do not inject buttons into Netflix, Disney+, or Crunchyroll control bars in the first release. Those interfaces change frequently, create accessibility and maintenance problems, and may increase platform-policy risk.

### Create a room

1. The host opens a supported title and clicks the extension icon.
2. The side panel recognizes the service and title, then offers **Start synced room**.
3. The server creates a short-lived room with an unguessable invite link and an eight-character human code.
4. The host shares either the link or code.
5. The host is paused locally while the room waits for members to become ready.

### Join a room

1. A member opens the invite link or enters the code in the side panel.
2. SyncYourJoy identifies the intended service and canonical title/episode without copying credentials or media.
3. The member signs into their own subscription and opens the title. If a safe canonical link is available, the extension can offer an explicit **Open title** button.
4. The member presses **I'm ready**. This deliberate interaction also reduces autoplay-policy failures.
5. Playback begins only when the host starts it and the room's readiness policy is satisfied.

### Controls

- Host-only control is the default.
- Members see locked native controls and a clear **Ask to pause** action; local native actions are reverted to authoritative state with an explanation.
- The host can pass control to another participant. Control transfer is server-serialized and visible to everyone.
- Pause is immediate on the host and broadcast immediately.
- Play and seek use a very short, dynamically calculated future start time so clients begin together.
- If a participant buffers, the default small-room policy pauses everyone after a short debounce and resumes only when all are ready. A later setting can allow the room to continue and let that member catch up.

### Failure states that need first-class UI

- wrong service, title, season, episode, cut, or duration;
- participant not signed in or subscription unavailable in their region;
- autoplay blocked until the participant clicks;
- participant buffering or tab suspended;
- extension lost access after a site update;
- host disconnected;
- room expired or code invalid;
- high latency or persistent drift.

Never silently pretend a participant is synchronized. The status pill should use plain states such as **In sync**, **Catching up**, **Waiting for Sara**, **Wrong episode**, and **Connection lost**.

## 3. Scope

### MVP (P0)

- Chrome desktop, Manifest V3;
- two to ten participants;
- ephemeral rooms with invite link and human code;
- guest nickname, no required account;
- host-only play, pause, and seek;
- pass-the-remote control transfer;
- participant readiness and content-match gate;
- buffering detection and pause-for-everyone policy;
- reconnect and authoritative state recovery;
- generic HTML5 adapter and a low-risk public test platform such as YouTube;
- first-class adapter feasibility spikes for Netflix, Crunchyroll, and Disney+;
- sync telemetry that records timings and errors, never media, credentials, cookies, full browsing history, or page HTML;
- keyboard-accessible side panel and in-page status pill.

### Next (P1)

- reactions and lightweight text chat;
- co-hosts and configurable control policy;
- episode-transition coordination;
- Firefox/Edge portability assessment;
- optional accounts for stable identity and room history;
- adapter health dashboard and remote feature flags containing data only, not executable extension logic;
- regional routing and automated multi-region latency tests.

### Later (P2)

- voice/video chat, only if demand justifies the privacy and echo complexity;
- mobile or TV companion experiences;
- scheduled public events and larger rooms;
- discovery, social graph, or monetization.

### Explicit non-goals

- screen sharing or retransmitting media;
- bypassing DRM, ads, geo-restrictions, subscription limits, or authentication;
- sharing streaming credentials or cookies;
- automatically discovering or scraping a user's viewing history;
- claiming affiliation with a streaming service without permission.

## 4. Platform rollout gates

Treat every streaming platform as a separately versioned adapter with technical, policy, and legal gates.

| Tier | Purpose | Gate |
| --- | --- | --- |
| Generic HTML5 + YouTube | Prove protocol, UX, and drift correction safely | Automated two-browser tests meet the sync objectives |
| Crunchyroll | First subscription-service feasibility target | Stable media detection, no DRM interaction, terms review, and repeated episode-transition tests |
| Netflix | High-value target | Stable adapter without reverse engineering or protected-data access, terms review/permission strategy, and regional/title tests |
| Disney+ | High-value but higher policy risk | Written legal/product decision before public distribution; no protected-player reverse engineering or automated scraping |

Existing watch-party extensions demonstrate market demand and technical feasibility, but their existence does not grant platform permission. Public launch or monetization should wait for qualified terms/legal review and, where practical, platform outreach.

## 5. Milestones

### M0 — Foundation

- confirm product name and repository conventions;
- approve the product promise, MVP scope, platform order, and privacy boundaries;
- decide whether Cloudflare is acceptable for the first backend;
- define the test matrix and measurable sync objectives.

### M1 — Protocol simulator

- implement shared protocol types and deterministic room state machine;
- build a browser-based fake-player harness with configurable delay, packet reordering, buffering, disconnects, and clock skew;
- prove command ordering, host leases, reconnect, and drift correction before touching commercial players.

### M2 — Extension vertical slice

- Manifest V3 extension shell;
- side panel and in-page pill;
- generic HTMLMediaElement adapter;
- create/join/ready/play/pause/seek across two Chrome profiles;
- local and preview backend environments.

### M3 — Reliability

- adaptive clock synchronization and scheduled commands;
- buffering coordination, episode mismatch protection, reconnect, and host handoff;
- end-to-end tests with network shaping;
- privacy disclosures, retention controls, abuse limits, and operational dashboards.

### M4 — Platform adapters

- complete one adapter at a time behind a kill switch;
- add adapter fixtures, capability detection, health checks, and rollback;
- run technical and terms/legal gate before enabling each platform publicly.

### M5 — Private pilot and store readiness

- invite-only pilot with consented telemetry;
- validate service objectives and revise thresholds;
- Chrome Web Store privacy policy, permission justification, disclosure, support flow, and review package;
- publish only after platform and policy gates are resolved.

## 6. Acceptance scenarios for the first usable build

1. Two clean Chrome profiles join the same room and correct title.
2. Host presses pause; host stops immediately and member stops within the measured objective.
3. Host resumes; both players start on the same scheduled timeline.
4. Member seeks locally; the client returns to authoritative state and explains why.
5. Host seeks; all ready clients move to the same position without event loops.
6. Member buffers; the room follows the selected buffering policy and resumes coherently.
7. Member disconnects for 15 seconds; reconnect restores the latest room revision and position.
8. Host disconnects; room pauses and performs the documented host-recovery flow.
9. Member opens the wrong episode; readiness is blocked and no playback command is applied.
10. Packets arrive late or duplicated; commands are applied in revision order and at most once.

## 7. Decisions requested before implementation

- Approve or change the working name `SyncYourJoy`.
- Approve Chrome desktop as the first client.
- Approve the dual UI: in-page status pill plus side panel.
- Approve host-only control and pause-for-everyone buffering defaults.
- Approve Cloudflare Workers + Durable Objects as the first backend direction.
- Choose the first subscription-service feasibility target: Crunchyroll is recommended before Netflix and Disney+.
- Decide whether platform permission/legal review is a hard gate before private testing or only before public distribution.
