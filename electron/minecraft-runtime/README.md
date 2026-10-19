# DeskPet Minecraft runtime

This isolated helper migrates the Minecraft task engine from `live2d-mc-companion` into DeskPet Electron. The Electron app owns the interface, configuration, provider access and process lifecycle. This helper owns the Java Edition game connection, world observations, pathfinding, physical actions, task cancellation and local Minecraft learning data.

The copied engine includes following and escorting, navigation, gathering and mining, combat, crafting and smelting, farming, nearby container transfer, and house or portal blueprints. These are source capabilities, not a claim that every action has passed a live game regression in DeskPet. The migrated registry also retains longer progression actions; the first DeskPet interface focuses on companion commands.

`PROVENANCE.json` records the original repository HEAD, branch, actual copied working-file hashes, destination hashes and the local engine adaptations. The source was dirty and included untracked modules; the hashes, rather than HEAD alone, identify the imported code. No source configuration, environment file, account token, chat history, private learning memory, Live2D asset, Cubism SDK, Express server or Electron interface was imported. No top-level license was present in the source project; the user authorized migration of their project. Dependency packages retain their own licenses.

## Parameterized reuse and candidate catalog

Recognized single operations use registered actions directly. `采五块木头` and
`采十块木头` select the same `gather_wood` action with different `count` arguments.
Chinese and Arabic explicit resource quantities must be integers in 1–256;
invalid quantities are rejected rather than truncated or silently defaulted.
Compatible exact learned-template hits skip model reranking, including in hybrid
mode. Fresh quantities, player names and coordinates remain owned by the new
request, and every physical action still passes the existing executor guards.

The legacy learning file now uses a same-directory temporary file, fsync and
atomic rename. Pending changes flush on disposal. Unreadable learning files and
catalogs are preserved instead of overwritten with empty fallback state.

Completed tasks additionally record parameterized JSON action candidates in
`minecraft-agent-learning.json.skills.json`. Candidates bind the registered
action contracts, source snapshot digest, resolved Minecraft version and
dimension. A single completion does not enable them. The lifecycle is candidate
→ validated → enabled → revoked. Enabling requires a trusted host
`validateSkillEvidence(manifest, evidence)` function, both at promotion and at
subsequent retrieval. `createRuntime` accepts that function as a host option;
game chat, model output and JSONL commands cannot install one or promote a skill.
The default verifier reads the fixed host-owned approval file next to the
learning file: `minecraft-agent-learning.json.skill-approvals.json`. Missing,
corrupt, revoked or mismatched approvals leave candidates disabled. Approval is
rechecked on every retrieval; game messages, model output and task JSON cannot
populate this file. Tests exercise the lifecycle using explicitly modeled
evidence; those tests are not native world acceptance.

The trusted local host tool `tools/approve-house-skill.cjs` closes the initial
house qualification workflow. It requires absolute catalog/approval/evidence
paths and explicitly pinned SHA-256 hashes for the frozen source manifest, full
QA receipt, independent closed-world audit and original result. The QA receipt
must bind the same manifest and vendor source digest. The independent audit
must confirm normal process closure and actual NBT/MCA/game-state acceptance;
the task plan, self-gathered profile, Minecraft version and source must match the
candidate. Actual native package files are also bound to the independently
audited hashes, with Node major/version applicability. Restart the helper after
source or package changes. Failed or partial runs cannot approve it. The tool atomically stores
host approval, validates the candidate and enables it for restart retrieval.
This tool is not a registered game action or JSONL command.

Approval scope explicitly records the tested world seed and full regression.
It never declares universal terrain reliability. All later requests compile
fresh parameters and retain the existing live executor guards. Other skill
families need their own trusted qualification receipt format; this first host
tool accepts the self-gathered house workflow only.

The trusted agent host APIs are `getSkillCatalogSnapshot`,
`validateSkillCandidate`, `enableSkillCandidate` and `revokeSkillCandidate`.
An enabled catalog hit executes the current registered plan with fresh request
parameters. It does not execute JavaScript or replay old world coordinates.
Source upgrades or version/dimension mismatches require revalidation. Source
digests are captured once per process; restart after source changes.

This catalog adds no arbitrary-code execution, shell, network or model access.
Self-gathered house learning retains its separate whole-house authority gate;
component successes cannot become whole-house successes.

## Installation and process entry

The helper needs Node.js 22 or newer. DeskPet starts it with its own Electron executable in Node mode, so end users do not need a separate Node installation. Its directory and production dependencies are packaged outside ASAR.

```sh
npm ci --ignore-scripts
npm test
node bridge.js --data-dir /absolute/path/to/isolated-minecraft-data
```

`--data-dir` is mandatory and must be absolute. The parent supplies a directory under its own user-data directory, not the source project or its old data folder. Microsoft profiles, learning state and diagnostics stay inside that directory. The helper does not load `.env`, import source settings, open a listening HTTP/WebSocket port, or connect automatically at startup.

## JSONL protocol v1

Each stdin and stdout message occupies one UTF-8 line, with a maximum input size of 1 MiB. Diagnostic console output goes to stderr. Every request includes `version: 1`, a string `id`, and `type`. Every accepted or rejected request gets a matching `reply` with `ok` and an optional `error`.

```json
{"version":1,"id":"connect-1","type":"connect","config":{"host":"127.0.0.1","port":25565,"username":"DeskPet","auth":"offline","version":"auto","ownerName":"YourPlayer","executorMode":"strict"}}
{"version":1,"id":"task-1","type":"command","command":{"type":"mc_command_submit","command":"跟着我","context":{"playerName":"YourPlayer"}}}
{"version":1,"id":"pause-1","type":"command","command":{"type":"mc_command_pause"}}
{"version":1,"id":"query-1","type":"command","command":{"type":"mc_command_query"}}
{"version":1,"id":"disconnect-1","type":"disconnect"}
{"version":1,"id":"shutdown-1","type":"shutdown"}
```

Connection requests support `auth: "offline" | "microsoft"`, `version: "auto" | "1.21.8"` (an explicit Java version), and `executorMode: "strict" | "hybrid"`. A successful connect reply only confirms that connection startup was accepted. `mc_control_state.control.connectionState === "connected"` and `mc_status.status.connected === true` are emitted after Mineflayer's `spawn` event; receiving a login packet alone does not mark the world ready.

Supported command types are `mc_command_submit`, `mc_command_replace`, `mc_command_cancel`, `mc_command_pause`, `mc_command_resume`, `mc_command_query`, `mc_diagnostics_query`, `mc_learning_query`, and `chat`. Task commands carry `command`; chat carries `message`. Chat is a single ordinary message, at most 256 characters; slash commands and newlines are rejected. Task commands are limited to 4,000 characters. Only whitelisted data reaches the source engine. Runtime AI credentials and arbitrary executable JavaScript are rejected.

The helper emits:

- `{version:1,type:"ready",capabilities:{...}}` when initialized; it remains disconnected.
- `{version:1,type:"reply",id,ok,error?}` for command acceptance or rejection.
- `{version:1,type:"event",event: originalMinecraftPayload}` for the original engine event protocol.
- `{version:1,type:"planner_request",requestId,messages,temperature}` when hybrid command planning needs the host's configured AI provider.

Original events include `mc_status.status`, `mc_control_state.control`, `mc_task_status.task/foregroundTask/backgroundTask/history`, `mc_inventory_snapshot.inventory`, `mc_world_context.context`, `mc_task_event.event`, `mc_task_log.log`, and `mc_error.message`. Game chat, player joins/leaves and death/respawn arrive in `mc_event.event`. Microsoft login emits `mc_auth_device_code` with `userCode`, `verificationURI`, `message` and `expiresIn`; these are short-lived login instructions, not provider credentials.

For a planner request, the host replies with either:

```json
{"version":1,"id":"planner-ack-1","type":"planner_result","requestId":"request-uuid","text":"{\"mode\":\"task\",\"steps\":[]}"}
{"version":1,"id":"planner-ack-2","type":"planner_result","requestId":"request-uuid","error":"AI provider unavailable"}
```

The host keeps API keys in DeskPet's existing provider system. Strict mode never emits a planner request. Hybrid enables AI planning and bounded mid-task revision for explicit user tasks; it does not arm autonomous maintenance. The source engine still preserves its existing survival and companion reflexes while connected. The helper does not silently reconnect or resume tasks across a disconnected session. Outstanding planner promises reject immediately on pause, cancellation or disconnect, and replies from a prior connection generation cannot affect a new session.

## Corrections to inherited execution logic

The imported working tree contained defects that could interrupt a task after it had started. Dropped items now use registry/name identity, including current Mineflayer's `other` entity type and legacy `object` entities. Drop-distance checks accept both plain coordinates and Vec3 values. Item-drop perception uses Mineflayer's version-aware `getDroppedItem()` decoder; tests exercise actual 1.21.8 entity/item metadata at index 8. Hostile detection likewise accepts the current registry's `hostile` type and legacy named `mob` entities. Empty-inventory escort preparation no longer references an undefined pickaxe constant.

Continuous follow and escort keep monitoring beyond the former 30-second monitor window and 3-minute step deadline. Healthy stationary following within the current goal range produces a heartbeat in both strict and hybrid modes. A previously stable movement session does not fabricate a heartbeat after its target moves away: missing physical movement still triggers recovery after 6.5 seconds, and missing task heartbeat still triggers the step's 12-second idle watchdog. Finite return-to-owner steps retain their 45-second deadline.

DeskPet supplies an explicit owner callback. A blank owner produces `missing_owner` for follow/escort unless the command names a player; an absent named owner never falls back to a nearby stranger. Original engine integrations that omit this callback retain the legacy visible-player inference. Disconnect/world-transition snapshots retain the interrupted foreground task's terminal state alongside history.

## Deliberate differences and validation limits

- Java Edition is supported by the bundled Mineflayer ecosystem. Bedrock is not supported. An unsupported server version produces a connection error; it is not silently remapped.
- The source's experimental `26.x` protocol/data remapping module is preserved only in `vendor/archive/minecraftVersionCompat.js`, with provenance. The active runtime never loads it. Experimental chat-only transport is not active.
- Microsoft device-code login is wired through Mineflayer and isolated profiles. Unit tests cover callback plumbing and stale-code isolation; no live Microsoft login was run for this migration.
- Source automatic game-chat AI replies and their shared chat-memory system were not imported. The DeskPet panel mirrors incoming game chat, sends ordinary chat, accepts explicit companion tasks, and delegates hybrid task planning through the existing host provider.
- No remote Minecraft server or live provider request was used. A local offline Minecraft-protocol 1.16.5 fixture exercised a real Mineflayer client's spawn and chat; it supplied no terrain chunks and does not prove collection or pathfinding. Automated checks additionally cover protocol limits, fake transport readiness/failure, stale events, planner correlation/cancellation, process startup/shutdown, real-engine planning pause/resume/cancellation races, strict-mode provider isolation, actual 1.21.8 item/entity metadata, and the migrated engine's module/learning contracts. Live follow/escort, mining, combat, crafting, building, Microsoft auth and cross-platform packaged execution remain separate integration checks.
