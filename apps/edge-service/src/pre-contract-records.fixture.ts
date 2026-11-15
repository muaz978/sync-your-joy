// Retained samples of what the v0.2.4 edge service wrote to Durable Object storage under the key `room`
// (its `StoredRoom`: coordinator export, pending controller recovery, empty-room clock, creation time).
//
// They were produced by running the RoomCoordinator of the v0.2.4 tag (git archive v0.2.4 packages, run with
// a fixed clock starting at 1_900_000_000_000) and are kept here as they were printed. Do not regenerate them
// from the current code: their value is that they are what an older release wrote. They have no `contract`,
// no `stateVersion` and no `disconnectGrace`, and, except the last one, their participants have no
// `capabilities`. The last one is what the v0.2.4 code wrote after it read a record of the current code (a
// rollback), so its participants keep the `capabilities` they were given. All values are synthetic (a
// made-up room, names and media).
//
// Evidence class: a sample of the stored shape of one older release, produced from that release's source.
// It is not a record read from a deployed Durable Object.

/** A room that is playing, with one report from each player (play at 20 s, reports at 20.9 s). */
export const V0_2_4_PLAYING_ROOM: unknown = {
  "coordinator": {
    "identity": {
      "roomId": "room_v024",
      "code": "EDGE1234"
    },
    "revision": 5,
    "leaseEpoch": 1,
    "controllerId": "participant_host",
    "media": {
      "service": "youtube",
      "canonicalId": "youtube:private-id",
      "title": "A private title",
      "durationSeconds": 600
    },
    "playback": {
      "status": "playing",
      "positionSeconds": 20,
      "effectiveAtServerMs": 1900000000240,
      "playbackRate": 1
    },
    "participants": [
      {
        "id": "participant_host",
        "name": "Muaz",
        "role": "controller",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "host_token_aaaaaaaaaaaa",
        "lastSample": {
          "positionSeconds": 20.9,
          "durationSeconds": 600,
          "paused": false,
          "buffering": false,
          "progressed": true,
          "playbackStarted": true,
          "sampledAtLocalMs": 1900000001100
        },
        "lastSampleReceivedAtMs": 1900000001100,
        "lastProgressAtServerMs": 1900000001100
      },
      {
        "id": "participant_friend",
        "name": "Rana",
        "role": "member",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "friend_token_aaaaaaaaaa",
        "lastSample": {
          "positionSeconds": 20.9,
          "durationSeconds": 600,
          "paused": false,
          "buffering": false,
          "progressed": true,
          "playbackStarted": true,
          "sampledAtLocalMs": 1900000001100
        },
        "lastSampleReceivedAtMs": 1900000001100,
        "lastProgressAtServerMs": 1900000001100
      }
    ],
    "actionIds": [
      "action_play_1900000000100"
    ],
    "navigation": null,
    "controlRevisionFloor": 4,
    "pendingSeek": null,
    "pendingJoinRequests": []
  },
  "pendingController": null,
  "emptySinceMs": null,
  "createdAtMs": 1900000000000
}

/** A paused room in the middle of a seek barrier to 90 s: the host has aligned, the friend has not. */
export const V0_2_4_PENDING_SEEK_PAUSED_ROOM: unknown = {
  "coordinator": {
    "identity": {
      "roomId": "room_v024",
      "code": "EDGE1234"
    },
    "revision": 5,
    "leaseEpoch": 1,
    "controllerId": "participant_host",
    "media": {
      "service": "youtube",
      "canonicalId": "youtube:private-id",
      "title": "A private title",
      "durationSeconds": 600
    },
    "playback": {
      "status": "paused",
      "positionSeconds": 90,
      "effectiveAtServerMs": 1900000000100,
      "playbackRate": 1
    },
    "participants": [
      {
        "id": "participant_host",
        "name": "Muaz",
        "role": "controller",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "host_token_aaaaaaaaaaaa",
        "lastSample": null,
        "lastSampleReceivedAtMs": 1900000000000,
        "lastProgressAtServerMs": 1900000000000
      },
      {
        "id": "participant_friend",
        "name": "Rana",
        "role": "member",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "friend_token_aaaaaaaaaa",
        "lastSample": null,
        "lastSampleReceivedAtMs": 1900000000000,
        "lastProgressAtServerMs": 1900000000000
      }
    ],
    "actionIds": [
      "action_seek_1900000000100"
    ],
    "navigation": null,
    "controlRevisionFloor": 4,
    "pendingSeek": {
      "revision": 5,
      "positionSeconds": 90,
      "resumeWhenReady": false,
      "deadlineAtServerMs": 1900000001900,
      "acknowledgedParticipantIds": [
        "participant_host"
      ]
    },
    "pendingJoinRequests": []
  },
  "pendingController": null,
  "emptySinceMs": null,
  "createdAtMs": 1900000000000
}

/** A room that was playing when the host seeked to 90 s: the barrier resumes playback once everyone has aligned; the host has aligned, the friend has not. */
export const V0_2_4_PENDING_SEEK_RESUME_ROOM: unknown = {
  "coordinator": {
    "identity": {
      "roomId": "room_v024",
      "code": "EDGE1234"
    },
    "revision": 6,
    "leaseEpoch": 1,
    "controllerId": "participant_host",
    "media": {
      "service": "youtube",
      "canonicalId": "youtube:private-id",
      "title": "A private title",
      "durationSeconds": 600
    },
    "playback": {
      "status": "paused",
      "positionSeconds": 90,
      "effectiveAtServerMs": 1900000002100,
      "playbackRate": 1
    },
    "participants": [
      {
        "id": "participant_host",
        "name": "Muaz",
        "role": "controller",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "host_token_aaaaaaaaaaaa",
        "lastSample": null,
        "lastSampleReceivedAtMs": 1900000000000,
        "lastProgressAtServerMs": 1900000000240
      },
      {
        "id": "participant_friend",
        "name": "Rana",
        "role": "member",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "friend_token_aaaaaaaaaa",
        "lastSample": null,
        "lastSampleReceivedAtMs": 1900000000000,
        "lastProgressAtServerMs": 1900000000240
      }
    ],
    "actionIds": [
      "action_play_1900000000100",
      "action_seek_1900000002100"
    ],
    "navigation": null,
    "controlRevisionFloor": 4,
    "pendingSeek": {
      "revision": 6,
      "positionSeconds": 90,
      "resumeWhenReady": true,
      "deadlineAtServerMs": 1900000003900,
      "acknowledgedParticipantIds": [
        "participant_host"
      ]
    },
    "pendingJoinRequests": []
  },
  "pendingController": null,
  "emptySinceMs": null,
  "createdAtMs": 1900000000000
}

/** A room with one request waiting for the host. */
export const V0_2_4_PENDING_REQUEST_ROOM: unknown = {
  "coordinator": {
    "identity": {
      "roomId": "room_v024",
      "code": "EDGE1234"
    },
    "revision": 1,
    "leaseEpoch": 1,
    "controllerId": "participant_host",
    "media": {
      "service": "youtube",
      "canonicalId": "youtube:private-id",
      "title": "A private title",
      "durationSeconds": 600
    },
    "playback": {
      "status": "paused",
      "positionSeconds": 0,
      "effectiveAtServerMs": 1900000000000,
      "playbackRate": 1
    },
    "participants": [
      {
        "id": "participant_host",
        "name": "Muaz",
        "role": "controller",
        "ready": false,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "host_token_aaaaaaaaaaaa",
        "lastSample": null,
        "lastSampleReceivedAtMs": 1900000000000,
        "lastProgressAtServerMs": 1900000000000
      }
    ],
    "actionIds": [],
    "navigation": null,
    "controlRevisionFloor": 1,
    "pendingSeek": null,
    "pendingJoinRequests": [
      {
        "id": "participant_friend",
        "name": "Rana",
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "sessionToken": "friend_token_aaaaaaaaaa",
        "requestedAtMs": 1900000000000
      }
    ]
  },
  "pendingController": null,
  "emptySinceMs": null,
  "createdAtMs": 1900000000000
}

/**
 * What the v0.2.4 coordinator wrote back after it restored a record of the current code (stateVersion 2, a committed
 * Play for two members that advertise the current contract, the room playing) and exported it again: the rollback
 * round trip. The v0.2.4 code ignored the contract section, the state version and the disconnect-grace list when
 * it read the record and did not write them, and kept each participant's `capabilities` as an unknown field. Produced
 * by running the v0.2.4 RoomCoordinator over a record the current code (0.2.12) exported with the same fixed clock.
 */
export const V0_2_4_RECORD_AFTER_ROLLBACK_OF_A_COMMITTED_ROOM: unknown = {
  "coordinator": {
    "identity": {
      "roomId": "room_v024",
      "code": "EDGE1234"
    },
    "revision": 6,
    "leaseEpoch": 1,
    "controllerId": "participant_host",
    "media": {
      "service": "youtube",
      "canonicalId": "youtube:private-id",
      "title": "A private title",
      "durationSeconds": 600
    },
    "playback": {
      "status": "playing",
      "positionSeconds": 20,
      "effectiveAtServerMs": 1900000000240,
      "playbackRate": 1
    },
    "participants": [
      {
        "id": "participant_host",
        "name": "Muaz",
        "role": "controller",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "playbackStatus": "preparing",
        "sessionToken": "host_token_aaaaaaaaaaaa",
        "capabilities": {
          "contractVersion": 1,
          "capabilities": [
            "media-epoch",
            "operation-identity",
            "prepare-start",
            "binding-sequence"
          ]
        },
        "lastSample": null,
        "lastSampleReceivedAtMs": 1900000000240,
        "lastProgressAtServerMs": 1900000000240,
        "lastOperationObservation": {
          "mediaEpoch": 0,
          "operationId": "operation_c30f30723d0148e28d714cee13fa12fb",
          "bindingId": "binding_participant_host",
          "sourceGeneration": 1,
          "sampleSequence": 1
        }
      },
      {
        "id": "participant_friend",
        "name": "Rana",
        "role": "member",
        "ready": true,
        "connected": true,
        "mediaMatches": true,
        "latencyMs": null,
        "joinedAtMs": 1900000000000,
        "media": {
          "service": "youtube",
          "canonicalId": "youtube:private-id",
          "title": "A private title",
          "durationSeconds": 600
        },
        "playbackStatus": "preparing",
        "sessionToken": "friend_token_aaaaaaaaaa",
        "capabilities": {
          "contractVersion": 1,
          "capabilities": [
            "media-epoch",
            "operation-identity",
            "prepare-start",
            "binding-sequence"
          ]
        },
        "lastSample": null,
        "lastSampleReceivedAtMs": 1900000000240,
        "lastProgressAtServerMs": 1900000000240,
        "lastOperationObservation": {
          "mediaEpoch": 0,
          "operationId": "operation_c30f30723d0148e28d714cee13fa12fb",
          "bindingId": "binding_participant_friend",
          "sourceGeneration": 1,
          "sampleSequence": 1
        }
      }
    ],
    "actionIds": [
      "action_play_1900000000100"
    ],
    "navigation": null,
    "controlRevisionFloor": 4,
    "pendingSeek": null,
    "pendingJoinRequests": []
  },
  "pendingController": null,
  "emptySinceMs": null,
  "createdAtMs": 1900000000000
}
