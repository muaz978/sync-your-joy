# Durable Object runtime observations, 2026-10-15

**Status:** Observations from single runs on a throwaway Worker. They are not guarantees and were not repeated.

The room coordinator (`apps/edge-service`) was written and tested against a fake Durable Object context. Several of its assumptions concern the real Workers runtime. This record states what was observed there, how far it goes, and what it means for the code.

## Method and limits

- A small throwaway Worker with a hibernatable-WebSocket Durable Object class (SQLite-backed) was deployed to the maintainer's Cloudflare account under a name that is not the production Worker's, driven with synthetic sockets, and deleted afterwards. The deletion was checked with the platform's own answer (the Worker no longer exists on the account); its Durable Object namespace and data were not listed separately and are inferred gone with the script.
- The production Worker was not touched. Every changing call in the experiment's wrangler logs names the throwaway script, and the production deployment list, which was only read, shows no deployment after the one recorded at 2026-09-29. A deployment list does not show secret or setting changes, and wrangler logs cover only calls wrangler made, so this is "by the evidence available".
- Compatibility date `2026-08-08`, wrangler 4.147.0, one account, one region. Each case is one run unless stated. Timings are corrected for a client round trip of about 59 ms and are good to about 30 ms.
- The probe scripts are not in the repository and the throwaway Worker no longer exists, so nothing here can be re-run from the record. An independent audit re-read the retained raw data and corrected the first write-up; the rows below carry its corrections. Statements that no retained file supports are left out and listed under "Not established".

## What was observed

| # | Question | Observation |
|---|---|---|
| E1 | Does `close()` throw on a socket that is closing or closed? | No, in every state tried (inside `webSocketClose`, a second call, on a closed socket, on a retained reference). `send()` after `close()` does throw `TypeError`. |
| E2 | Is the closing socket still listed by `getWebSockets()` inside `webSocketClose`? | Yes, by identity and by attachment, at handler entry and after an `await` inside the handler; it is unlisted once the handler returns. |
| E3 | How long between a client `close()` and `webSocketClose`? | About 40 ms. A server-initiated `close()` stays listed (`readyState` 2) until the peer replies; with a peer that never replied it stayed listed for the whole 15 s window. Liveness logic should therefore also look at `readyState`. |
| E4 | After a hibernation wake, what does the constructor see? | All sockets, with complete attachments, before any handler runs (three rooms, two sockets each, after 45 s idle). A wake caused by a close or a terminate still lists the closing socket as open in the constructor, and `webSocketClose` is then delivered to the same new instance. |
| E5 | What does a code update do to a room? | An object that was **hibernating** at deploy time ran the new version at its next wake with its sockets and attachments intact; so did an object that went idle after the deploy (checked 25 to 123 s after the deploy finished). An object that was **active** kept serving the previous version, with no close and no instance change, for about 300 s after the deploy finished (299 s and 300 s in the two runs), then both sockets closed with code 1006, no `webSocketClose` was delivered to any instance, and the new instance saw zero sockets. |
| E5b | Does `durable_objects.code_update_strategy: immediate` change that? | Not observed: with the setting omitted (default deferred) the active object behaved the same (old code until about 299 s, then a reset with 1006). wrangler 4.147.0 does send the setting. One run per mode, no no-deploy control for a connection older than 330 s, and the server-side recording of the mode was not verified, so this is "no difference seen", not "no effect". |
| E6 | Alarms | `getAlarm()` in the constructor returns the scheduled time (also for the instance that the alarm itself constructed) and null when none is set; inside `alarm()` it returns null; `deleteAll()` cancelled a pending alarm (it never fired). A throwing handler was invoked six times, at +0, +2.1, +6.9, +15.5, +34.1 and +67.2 s (retry counts 0 to 5: roughly doubling spacing); a seventh attempt, the absence of further attempts and the stale `getAlarm()` after exhaustion are consistent with the documentation but are not backed by a retained file. |
| E7 | `ctx.abort()` | The aborting request returned HTTP 500; both sockets closed with 1006 (empty reason) within 100 ms; the new instance saw zero sockets; no `webSocketClose` or `webSocketError` appears in the log as read about 6 s later (a longer wait was not retained). One sample. |
| E1b | Is the client's close handshake completed without `socket.close()` in `webSocketClose`? | Not completed in three of three runs at this compatibility date (no flag set): in one run the client saw code 1006 only when idle eviction took the object down, 10 s after its last request; in the other two the client saw no close event within 8 and 19 s. Cloudflare's documentation says the runtime replies automatically for compatibility dates from 2026-04-07, so this contradicts it or the setup differed; the cause is an inference. It needs a repeat with `web_socket_auto_reply_to_close` set explicitly, and against the real extension client, which never calls `close()` in its handler. |

## What it means for the coordinator

- The restore step relies on `ctx.getWebSockets()` and the attachments being complete inside the constructor: supported for a hibernation wake (E4). After a reset of an active object there are no sockets and no close events (E5, E7), so the stored participants are marked disconnected by the restore step and not by `webSocketClose`; that step is required, not a nicety.
- Excluding the handler's own socket by identity in `webSocketClose` is correct and necessary (E2). The `try`/`catch` around `socket.close()` is harmless but not needed (E1); the one around `send()` is needed.
- The restore step always writing and scheduling is consistent with E6: a stored alarm may be later than a deadline the new code has, and `getAlarm()` reports an alarm the instance itself was woken for, so it cannot be used as "nothing is scheduled".
- A deploy or a rollback should be planned as a window of about five minutes in which active rooms run the previous code, followed by one connection drop per room (E5). The figure is a planning estimate from two runs, not a bound, and nothing here shows when the last active room has been reset. Rooms created after the deploy run the new code at once.

## Not established

- Whether the pin has any effect on the real runtime (E5b), on this or another account, or for a longer or different traffic pattern. A connection that is simply older than about 330 s was not tested without a deploy, so a deploy-triggered timer is likely (the spread is smallest measured from the end of the deploy) but not proven.
- Whether sockets that survived a wake survive past the 300 s mark: the hibernated and post-wake runs were checked for at most 123 s after the deploy, and the platform's documentation says a code update disconnects all WebSockets.
- The production Worker's own behaviour.
- That the platform records the requested mode as the deployment's strategy.
- The close-handshake behaviour with an explicit auto-reply flag (E1b).
- Anything about other compatibility dates, KV-backed objects, other regions or load.
