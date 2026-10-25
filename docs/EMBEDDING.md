# Embedding the new core

Use Minecraft Companion as the bottom-level action engine for DeskPet, an LLM tool caller or another host. The host chooses data-only goals; the core owns movement and survival. No LLM/provider or Electron renderer is required. The legacy Electron bridge stays unchanged by default. This API does not imply that its UI is migrated or that every gameplay goal works on every seed.

## One contract, two transports

Use the pinned Node 22.22.0 / npm 10.9.4 and existing lockfiles:

```sh
node electron/minecraft-runtime/index.js --engine core --data-dir /absolute/private/core-data
# Or: npm run start:core --prefix electron/minecraft-runtime -- --data-dir /absolute/private/core-data
```

Each stdin line is JSON; stdout is exclusively JSONL, dependency logs go to stderr. The adapter opens no network listener. The host must protect its child-process pipes and choose an authorized server. It connects only when asked. Java offline/Microsoft connection configuration matches the legacy transport; Microsoft authentication emits `auth_device_code`. Never send passwords or API keys in tool arguments.

```json
{"version":1,"id":"connect-1","type":"connect","config":{"host":"127.0.0.1","port":25565,"username":"Companion","auth":"offline","version":"1.21.8"}}
{"version":1,"id":"tools-1","type":"tool","name":"listTools","arguments":{}}
```

Wait for `event.type = "connection"`, `event.state = "ready"`, not merely the connect reply. Then submit:

```json
{"version":1,"id":"wood-1","type":"tool","name":"gatherLogs","arguments":{"count":3}}
```

In-process callers use exactly the same envelopes and events:

```js
const { createCoreHost } = require('./electron/minecraft-runtime/core-host');
const host = createCoreHost({ dataDir: '/absolute/private/core-data', emit: onMessage });
// First connect and wait for connection.ready as above.
const receipt = await host.handle({ version: 1, id: 'wood-1', type: 'tool',
  name: 'gatherLogs', arguments: { count: 3 } });
// Keep receipt.result.task.taskId; this Promise is ONLY a dispatch receipt.
// onMessage later receives { type: 'event', event: { type: 'task', task: ... } }.
// await host.close() joins teardown and permanently closes this host.
```

`ready.capabilities.tools` and `listTools` return JSON schemas for 18 selected built-in goal names: gatherLogs, homestead, farm, ranch, gatherMaterials, cobbleGenerator, autoSmelter, caneFarm, mobFarm, ironFarm, carpetDuper, railDuper, fishing, netherQuartz, enterEnd, endDragon, endCity and endJourney. Their options are a conservative data-only subset. The upstream experimental `villageIronFarm` remains available through the lower-level companion but is not exposed by this tool catalogue. Unknown options, injected actions/bots, arbitrary `setGoal` objects, JavaScript and natural-language planner requests are rejected. Translate the schemas into an LLM provider's tool format in the host, without changing the engine.

## Lifecycle and correlation

Replies contain `{ version: 1, type: "reply", id, ok, result?, error? }`. A successful goal reply includes `result.task` and `dispatchOnly: true`. Tasks carry `taskId`, `requestId`, `name`, `status`, `paused`, timestamps and `connectionGeneration`.

The lifecycle is `accepted → running → completed | failed | cancelled`. Terminal states are immutable. Completion requires the core's goal-done observation, not dispatch-Promise resolution. An already-satisfied goal can complete before its reply arrives. Construction/dispatch errors produce a failed task and failed reply carrying that task.

Updates are `{ type: "event", event: { type: "task", taskId, task } }`. Detailed events use `event.type = "core"`, with `payload`, `taskId` (null for independent safety activity) and connection generation. Goal/action events capture immutable task IDs when installed. Old callbacks cannot settle newer same-name goals. Query retained tasks using `getTask` with `{ "taskId": "returned-id" }`, or use `getStatus` for live state.

`gatherLogs.count` is an additional minimum, not an absolute inventory count. Other goal semantics remain documented by their factories. Success means that goal's completion predicate, not independent proof of any arbitrary host objective.

## Concurrency and bounded idempotency

One goal owns the bot. A second is rejected with `busy` unless the envelope explicitly includes `replaceCurrent: true`. Replacement first joins cancellation of the old task, marks it cancelled, then dispatches the new one. Retired goals release their invocation-owned listeners and movement overrides after the body settles, before replacement is constructed. There is no implicit gameplay queue or background resubmission. Control operations are serialized with dispatch; at most 64 requests may be pending by default.

Envelope `id` is an idempotency key. Exact retries, including concurrent retries, share one dispatch and replay its original receipt, not a fresh snapshot. Different content with the same ID returns `id_conflict`. Use fresh request IDs for status polling and task IDs for correlation. Failed receipts are cached too; after fixing a condition, submit a new request ID.

Default retention is **256 requests/tasks, up to 10 minutes**, in memory only. Capacity pressure may evict settled entries earlier. The active task's request stays pinned past the TTL. Explicit reconnect preserves retained receipts; process restart does not. After eviction/restart the same ID can run again: this is not durable exactly-once execution. Inspect the world/current task before retrying after an ambiguous failure. `getStatus.idempotency` reports the configured bounds. A custom `historyLimit` must be at least 2 so a pinned active request leaves room for controls.

## Cancel, pause and complete stop

`cancel`, `pause` and `resume` require the returned task ID. Stale controls for retained terminal tasks return that task without affecting a newer one. Unknown/expired IDs return `task_not_found`.

- `cancel`: aborts the task and disables autonomous goal selection; survival remains active. Existing world changes are not rolled back.
- `pause`: suspends the task and autonomous selection, preserving goal state. Survival/maintenance can still move the body. The task stays running with `paused: true`; pause is not physical stillness.
- `resume`: replans the retained goal from the current world, not a saved movement step.
- `stopAll`: cancels the task, disposes the companion, halts controls and disconnects. Safety is off because the bot is disconnected. A later explicit connect creates a new companion.
- `disconnect`: also cancels/disposes/closes the connection. `shutdown` / `host.close()` additionally closes the host permanently. EOF or SIGINT/SIGTERM disposes the CLI host. Teardown stuck beyond five seconds exits nonzero, never claims clean shutdown.

The lower-level `createCompanion({ bot })` is still available for hosts owning Mineflayer. Existing methods/dispatch-return semantics remain compatible. It adds `submitTask(name, args, { taskId })`, `cancelTask`, `pauseTask`, `resumeTask`, `stopAll` and idempotent `dispose`. Legacy `companion.stop()` keeps safety active. Companion `stopAll`/`dispose` permanently stop companion activity, but its caller must disconnect the externally supplied bot. The core-host/JSONL `stopAll` also disconnects its owned bot.

## Explicit recovery, not automatic replay

Connection events expose `connecting`, `ready`, `disconnected`, `error` or `disposed`, generation and errors `{ code, message, retryable }`. Unexpected kick/end/error or readiness timeout fails the active task once and disposes the connection. Old spawn/error/action/completion callbacks cannot affect a replacement connection.

**No automatic reconnect or task recovery is implemented.** `retryable: true` permits an explicit attempt; it does not promise success or make replay safe. Authentication/server restrictions may need user intervention. Send `type: "reconnect"` with new or previous configuration, wait for ready, inspect state and submit a new request ID if appropriate. Intentional reconnect cancels the active task. Goal exhaustion is terminal with `retryable: false`; the host decides whether changed conditions justify another task. Death/respawn inside a live connection remains existing in-world replanning, not network reconnect. If teardown itself fails, connection status becomes nonretryable `cleanup_failed`; the host stays fail-closed and must be restarted before another engine is attached.

## Regression checks

```sh
npm run test:core --prefix electron/minecraft-runtime
npm test --prefix electron/minecraft-runtime
```

Unit tests cover duplicate dispatch, conflicting IDs, bounded history, replacement/stale callbacks, pause/cancel/stop, teardown and connection generations. The real-server harness runs a separate JSONL child, submits tools, observes terminal events and checks actual inventory through the server. It does not use an LLM or prove desktop UI/every gameplay scenario.

After reviewing and accepting the [Minecraft EULA](https://aka.ms/MinecraftEULA):

```sh
node electron/minecraft-runtime/tools/test-core-host.cjs --accept-eula \
  --installation /absolute/path/installation.json --output /absolute/new/result-dir
```

This uses an isolated loopback-only vanilla server, preserves receipts/events and saves/stops the server. Tie evidence to the actual tested commit; this narrow embedding regression does not reissue historical full-game acceptance.
