# Core validation report — v0.1.0-alpha.1 / 2026-10-24

**Frozen a22 offline and gameplay result: PASS; source developer preview v0.1.0-alpha.1.** Tested freeze: `a22a73a4a7294ab5409b6e74ee882b2603ab528b` (867 files, sourceHash `2b47b336ab2279cc27e12ebebf418e508e557e5b09ce4b35a91f97690bf3e73f`). The original complete runtime full7 naturally passed 3326/3326. Formal full03 naturally passed all24scenarios/32rounds, 2026-10-24 02:15:09.845—03:27:27.151 UTC, exit0, with matching final summary/JSONL and unchanged source/driver. The final importer independently reports ALL_PASS/32rounds/issues0. Every scenario has confirmed console save/close. Earlier complete offline failures, interrupted campaigns and observed recovery costs remain below; passing this finite campaign is not arbitrary-world reliability or desktop integration acceptance. Archive/install/privacy/publication receipts are distinct from the tested gameplay snapshot.

## Snapshot and environment

| Field | Value |
|---|---|
| Current gameplay/acceptance commit | `a22a73a4a7294ab5409b6e74ee882b2603ab528b` |
| Previous production snapshot / full6 | `4160a6e04ea53bbbfe77308a8a49ece9d77c32dd`; a22 changes only one legacy test, production unchanged |
| Pre-repair baseline | `43929e7c5272932757229c63418d5839885aa90d` |
| Historical cf0 repository-file manifest | 859 files |
| Historical cf0 aggregate source hash | `8fcc4eb94b65b1270f02628d81e33ffc1af64385c566b25bed7425be3090cc8d` |
| Historical cf0 frozen at | 2026-10-23 23:06:46.971 UTC |
| Current frozen aggregate source hash | `2b47b336ab2279cc27e12ebebf418e508e557e5b09ce4b35a91f97690bf3e73f` |
| Current repository-file manifest | 867 files |
| Current source identity recorded | 2026-10-24 02:05:08.850642 UTC; full03 started02:15:09.845 UTC |
| Node / npm recorded at final offline start | Node 22.22.0 / npm 10.9.4 |
| Gameplay protocol | Official vanilla Java Edition 1.21.8; Java 21; Mineflayer 4.37.1 |
| Formal suite | full: 24 scenarios, 32 rounds, every round required to pass |
| Formal concurrency | Up to 6 scenario processes |
| Current full7 / formal full03 | PASS3326/3326 / PASS24scenarios32/32rounds, both naturalexit0 |
| Formal result / final source match | ALL_PASS / unchanged a22/2b47, sourceChanges[] |
| Release scope | User-confirmed source developer preview |
| Release version / separate asset identity | v0.1.0-alpha.1; documentation/CI/offline-fixture/installer release commit and archive SHA-256 recorded separately |

The aggregate hash binds its repository-file manifest, not a source-archive checksum. Full03 runs against `a22a73a4a7294ab5409b6e74ee882b2603ab528b` and its 867-file frozen manifest. The sole 4160→a22 delta is `test/house-local-food-frontier-host-physics.test.js`; production bytes and original task/native/host deadlines remain unchanged. The earlier e1→4160 production repair adds bounded off-route rejoin and home-maintenance ownership. Historical batches retain their own source identities. A later release commit/archive with documentation, CI, offline-fixture and installer corrections needs its own manifest/SHA256. Runtime core/vendor and formal scenario/harness byte equivalence is checked separately; installer changes are declared independently. No dependency or Java/server bytes enter the intended source asset.

## Campaign conditions

Each scenario gets one new isolated vanilla server and world. Its original full-suite repeat count is then run in that world with fresh setup before each round and the CLI's default `reuse` bot lifecycle. This means **24 isolated worlds and 32 rounds**, not 32 independently generated worlds. E2E is one full run on one bot in its new world. None of these counts establishes broad multi-seed reliability.

The scenario CLI uses setup base seed **1 for `e2e-flat` and 101 for all other scenarios**. On repeated rounds the setup PRNG is seeded with `baseSeed + roundIndex * 7919`, where roundIndex starts at zero. The CLI seed controls prepared layouts/start positions; each scenario's `serverProperties['level-seed']` controls Minecraft terrain generation separately. A fresh saved world with the same level seed is still a fresh world, not a newly sampled terrain seed.

The full03 driver invokes the existing scenario CLI with each full entry's original `--runs N`, `--seed`, and one fresh batch name; it does not override `--start-run` or `--bot-lifecycle`. It prioritizes the long E2E, natural homestead and deep-mining cases, with at most six child processes. Every child's exit status, expected round count, round verdicts and post-run source hash are required by the campaign gate.

Original deadlines, difficulty, initial resources, fixture distribution and survival faults are retained. Setup now preloads and verifies all required chunks/commands/ore cells so a partial fixture cannot silently count as the intended test. Changing these conditions to obtain a pass would create a different test and must be disclosed as such.

## Interrupted full01 history

Formal batch full01 ran on b25 and was stopped for repair rather than completed. Its retained terminal evidence shows **15 completed scenarios / 20 rounds PASS**, **one mobfarm scenario FAIL**, **six interrupted scenarios** (E2E, natural homestead, iron mining, night bunker, farm and ranch) and **two queued/not-started scenarios** (flat homestead and machines). This is not a whole-suite result and does not supply any PASS to the current full03 matrix.

The mobfarm failure exposed an occupied collector placement cell; the E2E open-door and natural long-goNear observations motivated independent mechanism regressions. Owned Java and Node processes subsequently exited and existing world files/pre-stop logs were preserved. The six interrupted servers' final-save log acknowledgement remains **UNCONFIRMED**. Later successful console-stop probes do not retroactively confirm those saves.

## Interrupted full02 history

Full02 ran on e1 and was gracefully stopped for repair. **22 complete scenarios/29 rounds passed, plus farm round 1, for 30 passed rounds and 2 interrupted rounds** (E2E and farm round 2). No completed scenario failed; the campaign is **INTERRUPTED, not a completed full-suite PASS**. It contributes zero passes to full03. The two interrupted worlds have confirmed console save/close; all 24 owned world shutdown receipts are confirmed. Pre-stop JSONL prefixes and source identity remain unchanged.

The E2E exposed a mine-exit join where native AStar repeatedly returned success but the follower could not execute an ascending diagonal. Both ordinary and goal-local nudge recoveries moved laterally without gaining height. The planned second death interrupted that window. An independent replay of 504 post-injection saved block states reproduced the mechanism without Java or world mutation; it is explicitly not exact historical failure-time telemetry. A bounded loaded cardinal rejoin then physically reaches the route.

## Formal scenario matrix

Every result below is **PASS**, imported from the matching original final summary/JSONL and unchanged driver/source evidence. Full typed quantities, hashes and terminal lines are in [public summary](docs/validation/2026-10-24/validation-summary.json) and [per-round readback](docs/validation/2026-10-24/validation-results.json). Death counts include the2planned E2E injections; all other rounds have0deaths.

| Scenario | Rounds | Limit/round (min) | Difficulty | Prepared conditions and main contract | Result |
|---|---:|---:|---|---|---|
| `collect-logs-flat` | 3 | 5 | peaceful | Empty inventory; prepared trees; collect 10 logs | PASS3/3; 130428ms total; 0deaths |
| `collect-logs-natural` | 3 | 8 | peaceful | Empty inventory; natural terrain/start positions; 10 logs | PASS3/3; 163184ms total; 0deaths |
| `homestead-flat` | 1 | 120 | easy | Empty inventory; prepared trees/animals/ore; complete house, furniture use and iron gear | PASS1/1; 1284787ms total; 0deaths |
| `homestead-natural` | 1 | 150 | easy | Empty inventory; natural terrain; same house/gear/use contract | PASS1/1; 1576897ms total; 0deaths |
| `night-bunker-flat` | 2 | 15 | easy | Basic tools/food, no bed; confirm night, sealed bunker, dawn/surface, alive and no death | PASS2/2; 1408063ms total; 0deaths |
| `night-bed-flat` | 2 | 15 | easy | Basic tools/food and a bed; actual sleep, next morning/surface, alive and no death | PASS2/2; 293132ms total; 0deaths |
| `farm-flat` | 2 | 60 | easy | Empty inventory; trees/grass/pond, accelerated crop growth; till/sow/harvest/replant and 3 bread | PASS2/2; 1472445ms total; 0deaths |
| `ranch-flat` | 2 | 45 | easy | Two cows and 16 wheat supplied; pen/gate, lead both in and breed a calf | PASS2/2; 259853ms total; 0deaths |
| `nether-quartz-given` | 1 | 25 | easy | Portal/tools/food/gold helmet supplied; build portal, get 16 quartz and return overworld | PASS1/1; 64231ms total; 0deaths |
| `cobblegen-flat` | 1 | 6 | peaceful | Construction resources supplied; generator and 8 cobblestone | PASS1/1; 27106ms total; 0deaths |
| `cobblegen-hopper-flat` | 1 | 6 | peaceful | Resources/hopper/chest supplied; collect 8 from the generator collector | PASS1/1; 23541ms total; 0deaths |
| `smelter-flat` | 1 | 6 | peaceful | Hardware/raw iron/fuel supplied; build and take 8 ingots from output | PASS1/1; 95987ms total; 0deaths |
| `materials-cobblegen-flat` | 1 | 30 | peaceful | Empty inventory, controlled resources/home chest; store buckets and 10 cobblestone | PASS1/1; 395295ms total; 0deaths |
| `branch-mine-iron-flat` | 1 | 45 | peaceful | Empty inventory, controlled buried veins/home chest; return 12 raw iron | PASS1/1; 400018ms total; 0deaths |
| `canefarm-flat` | 1 | 8 | peaceful | Construction resources/initial cane supplied; collect 4 automatically harvested cane | PASS1/1; 183376ms total; 0deaths |
| `mobfarm-flat` | 1 | 25 | easy | Pickaxe/water/hopper/chest supplied; dark-room farm and 4 drops | PASS1/1; 372188ms total; 0deaths |
| `carpetdupe-flat` | 1 | 6 | peaceful | Construction resources/initial carpet supplied; 8 new carpets | PASS1/1; 22241ms total; 0deaths |
| `fishing-flat` | 1 | 8 | peaceful | Rod/shovel/two buckets supplied; build pond and independently catch/pick up 5 fish/junk/treasure catches | PASS1/1; 109648ms total; 0deaths |
| `raildupe-flat` | 1 | 8 | peaceful | Construction resources/initial rail supplied; 8 new rails | PASS1/1; 59505ms total; 0deaths |
| `ironfarm-flat` | 1 | 20 | easy | Hardware/lava/three villager eggs/one zombie egg supplied; structure, 3 villagers, live zombie, 3 ingots | PASS1/1; 110250ms total; 0deaths |
| `e2e-flat` | 1 | 300 | easy | Empty inventory, controlled resources, native day/night/mobs; final house/gear, two productive machines and all four fault recoveries | PASS1/1; 4269204ms total; 2deaths |
| `machines-flat` | 1 | 120 | peaceful | Stand-in furnished home/iron tools supplied; autonomy gathers materials and builds both productive machines | PASS1/1; 1830000ms total; 0deaths |
| `branch-mine-redstone-flat` | 1 | 75 | peaceful | Empty inventory, controlled deep veins/lava pockets; staged tool chain and return 16 redstone | PASS1/1; 807204ms total; 0deaths |
| `branch-mine-diamond-flat` | 1 | 90 | peaceful | Empty inventory, same controlled deep world; return 3 diamonds and encountered companion ore | PASS1/1; 1068046ms total; 0deaths |
| **Total** | **32** | Original limits | Original difficulty | **24 registered scenarios; 100% required** | **PASS32/32;2planned deaths** |

The construction-only and supplied-resource scenarios test their stated task boundaries. They do not prove autonomous acquisition of their supplied materials. The natural scenarios retain their stated seeds/locations and are not evidence for arbitrary public servers, plugins or all terrain.

## Measured per-round terminal results

All32rounds have serverPass=true, timedOut=false, no final failure/harness conflict and matching summary/result. Durations below are task measurements, not whole server setup/shutdown wall time.

| Scenario | Round | Setup seed | brainOutcome | Duration ms | Deaths | Final result |
|---|---:|---:|---|---:|---:|---|
| `collect-logs-flat` | 1 | 101 | goal_done | 43943 | 0 | PASS |
| `collect-logs-flat` | 2 | 8020 | goal_done | 42785 | 0 | PASS |
| `collect-logs-flat` | 3 | 15939 | goal_done | 43700 | 0 | PASS |
| `collect-logs-natural` | 1 | 101 | goal_done | 47581 | 0 | PASS |
| `collect-logs-natural` | 2 | 8020 | goal_done | 68842 | 0 | PASS |
| `collect-logs-natural` | 3 | 15939 | goal_done | 46761 | 0 | PASS |
| `homestead-flat` | 1 | 101 | goal_done | 1284787 | 0 | PASS |
| `homestead-natural` | 1 | 101 | goal_done | 1576897 | 0 | PASS |
| `night-bunker-flat` | 1 | 101 | None | 703230 | 0 | PASS |
| `night-bunker-flat` | 2 | 8020 | None | 704833 | 0 | PASS |
| `night-bed-flat` | 1 | 101 | None | 139589 | 0 | PASS |
| `night-bed-flat` | 2 | 8020 | None | 153543 | 0 | PASS |
| `farm-flat` | 1 | 101 | goal_done | 774071 | 0 | PASS |
| `farm-flat` | 2 | 8020 | goal_done | 698374 | 0 | PASS |
| `ranch-flat` | 1 | 101 | goal_done | 128368 | 0 | PASS |
| `ranch-flat` | 2 | 8020 | goal_done | 131485 | 0 | PASS |
| `nether-quartz-given` | 1 | 101 | goal_done | 64231 | 0 | PASS |
| `cobblegen-flat` | 1 | 101 | goal_done | 27106 | 0 | PASS |
| `cobblegen-hopper-flat` | 1 | 101 | goal_done | 23541 | 0 | PASS |
| `smelter-flat` | 1 | 101 | goal_done | 95987 | 0 | PASS |
| `materials-cobblegen-flat` | 1 | 101 | goal_done | 395295 | 0 | PASS |
| `branch-mine-iron-flat` | 1 | 101 | goal_done | 400018 | 0 | PASS |
| `canefarm-flat` | 1 | 101 | goal_done | 183376 | 0 | PASS |
| `mobfarm-flat` | 1 | 101 | goal_done | 372188 | 0 | PASS |
| `carpetdupe-flat` | 1 | 101 | goal_done | 22241 | 0 | PASS |
| `fishing-flat` | 1 | 101 | goal_done | 109648 | 0 | PASS |
| `raildupe-flat` | 1 | 101 | goal_done | 59505 | 0 | PASS |
| `ironfarm-flat` | 1 | 101 | goal_done | 110250 | 0 | PASS |
| `e2e-flat` | 1 | 1 | goal_done | 4269204 | 2 | PASS |
| `machines-flat` | 1 | 101 | goal_done | 1830000 | 0 | PASS |
| `branch-mine-redstone-flat` | 1 | 101 | goal_done | 807204 | 0 | PASS |
| `branch-mine-diamond-flat` | 1 | 101 | goal_done | 1068046 | 0 | PASS |

## Terminal verdict contract

The raw result retains the independent `serverPass` plus `timedOut`, `brainOutcome`, `failureReasons`, `harnessFailures`, goal history, duration and deaths. A verifier passing cannot override a timeout, final `goal_failed`/`stopped`, or harness/cleanup error. Intermediate autonomous goal failures may legitimately recover; their history remains visible, and the final independent scenario contract still has to pass.

For E2E all of the following must hold together at the end:

- The final house shell, furniture and required iron sword/pickaxe/shield pass independent readback. An earlier homestead `goal_done` is historical progress, not proof of a still-intact final house or retained gear.
- Table crafting and furnace opening are tied to the final furniture coordinates through native operations and independent server block/statistic growth; chest contents and exact bed respawn position are read independently.
- The hopper generator has regenerated and collected at least 8 units. Its correct, initially empty output must actually lose units while the player gains them; deposits/preloaded output/old player stock cannot stand in for production.
- The automatic smelter has produced and collected at least 4 ingots, with fresh recipe growth in that machine furnace and correct-source output/player deltas.
- `death_during_house`, `bag_full`, `pit`, and `death_during_machines` were all injected and recovered. The two planned deaths remain part of the scenario; extra deaths are reported separately from them and do not alone decide the whole verdict.
- Independent server and client readback show the bot alive, the overall limit has not expired, and no terminal or harness conflict remains.

A source hash mismatch, missing terminal result, mismatched summary/JSONL, incomplete fixture or an unfinished process cannot be classified PASS. Long windows without ore, low health and late recovery are recorded with timestamps; none is automatically a whole-run failure before the terminal result exists.

## Repair regressions and native protocol fixtures

The acceptance-owner offline regression group completed **32/32** before the previous freeze. It covers night false positives, timeout/brain conflicts, source-attributed machine production, target-bound furniture use, fishing catches, ore setup, absolute log offsets, hook cancellation, cleanup errors, late native completions and manifest consistency. It is a subset of the raw runtime suite and cannot override its failures.

| Original complete runtime run | Snapshot | Natural terminal result | Retained interpretation |
|---|---|---|---|
| full2 | cf0 | exit1;3175/3176,1fail | Legacy relocation low-health race; original failure retained |
| full3 | b25 | exit0;3180/3180,0fail/cancel/skip | Historical offline pass; formal full01 later interrupted |
| full4 | e6 | exit1;3274/3275,1fail,0cancel/skip | Native80ms test assumed a new floored node; original failure retained |
| full5 | e1 | exit0;3278/3278,0fail/cancel/skip/todo | Historical offline pass; formal full02 later interrupted |
| full6 | 4160 | exit1;3324/3325,1fail,0cancel/skip/todo | Native food-frontier fixture wall-clock timeout5157.821ms; original failure retained |
| **full7** | **a22** | **exit0;3326/3326,0fail/cancel/skip/todo** | **Current original complete npm test; sourceChanges[], no force-exit or intervention** |

Full4's native 80ms observation can legally confirm an existing node without a new visit; e1 corrects only the test's existing/new branches, retaining 80ms and 8 refusal guards (56 related checks). Full6's native food-frontier test mixed actual 20ms scheduling, 50ms simulated Physics, taskDate/timeouts and host load. The a22 test-only correction uses the same ideal 20/50 ratio and 250 ticks under logical 5000ms, with an independent real 8s watchdog; it changes no production code or deadline. Full7 ran 02:05:17.755→02:13:05.126 UTC, naturally exited0 with frozen a22/2b47 identity. Earlier passing runs cannot substitute for this new complete run. These are offline contracts, not formal gameplay cases.

Iteration2 receipts retain313/313core, host74/74, security6/6, legacyacceptance25/25 and lint/typecheck on e6. Exact-a22 execution receipts now independently pass host74/74, security6/6, legacyacceptance25/25 and lint/typecheck, naturally with unchanged source. An earlier exact-a22 host run had70/74 pass and4 local loopback listen EPERM fixture failures in the restricted environment; that failed execution is preserved. With local listening permitted, the same original npm test naturally passes74/74. Neither execution calls a real provider API or proves GUI/provider acceptance.

Iteration3 adds 38/38 mine-rejoin checks, 92/92 related checks and 17/17 home-maintenance checks. An independent offline probe runs the complete original first goTo without injecting no_progress, arrival or movement: the watchdog detects failure, cardinal fallback reaches the route in 12998ms total within 20s, profile restored, no mutations/UNKNOWN reads. Home maintenance receives a bounded body-ownership window even during a single long awaited unarmed gather action. These remain focused offline proofs; the separately completed full03 establishes its stated whole game contracts.

Separate fresh native-protocol fixtures established:

| Fixture observation | Evidence obtained | Boundary |
|---|---|---|
| Original iron setup, base seed 101 | 41 loaded chunks; all 302 final iron_ore cells independently checked | No mining task ran in this probe |
| Consecutive living setup | Two resets succeed with already-existing scoreboard objectives and empty entity kills | Initialization compatibility only |
| Native fishing | Five separately confirmed catches: salmon 1, cod 3, lily_pad 1; catch and eligible pickup counters advance each cast | Pond was prebuilt; this does not prove autonomous pond construction |
| Native furniture | Correct table/furnace block coordinates, completed native operations, server statistics 0→1 | Hardware and planks were supplied |
| Native sleep | Server day 0/time 13002 → day 1/time 62 or 63, sleep statistic 1 | Protocol/day wrap only, not the full night scenarios' dawn/surface contract |
| Native collector transfer | Correct-source server count 8→0 and player 0→8 | Cobblestone was injected solely to test readback attribution; not production acceptance |
| Native smelter transfer | Machine furnace smelted 4 raw iron, its RecipesUsed increased by 4, output transferred 4→0/player 0→4 | Raw iron, fuel and apparatus were supplied |
| Iteration2 door fixture, e6 | north/left and east/right native goto crossed both ways; forced original AStar first time-slice yielded partial→success with getter 1; server Pos and 140 cells per room×3 windows passed; closed doors NoPath/rejected and no dig/place/activate | Prebuilt protected rooms; no autonomous homestead/E2E claim; console save/close receipt passed |
| Iteration2 CLI interruption fixture, e6 | Requested 3 rounds; first SIGINT after real goal_set, then SIGTERM; one interrupted false result, no later round, natural exit 130; console/save/close passed | Expected cancellation-contract PASS, gameplay round remains INTERRUPTED/false |

These fixtures change their own controlled world and keep unsuccessful attempts. They are not additional passes in the 32-round formal total. Observers used by formal runs update only their own counters/advancement or read state; they do not feed the bot or generate output resources.

## First cloud CI failure and food-detour fixture correction

The first [PR CI run](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40060016518), attempt1, failed its original complete runtime command: **3325/3326 passed, 1 failed, 0 cancelled/skipped/todo**. Its checkout was synthetic merge `649806c9e49e6303adbb9d26ff600f20df9bb2cc`, with the exact same tree as candidate `07bd0f0feee80f85f7cb1691c7469d0bd914ca59`. Installation, lint, typecheck, host, security, legacy acceptance and tracked-source checks passed. This failed run remains part of the record and was not rerun or relabeled.

The only failed case was the grounded food detour around a pond in `test/house-surface-graph.test.js`. After107.08062ms it raised `dry_graph_rejoin_unconfirmed` before a confirmed reconnect. The initial body was about55.7m from the sole recorded anchor. The test omitted `nativeReachableHints`, although the actual `survival_food` caller explicitly enables it. Default mode deliberately keeps an inconclusive native100ms probe UNKNOWN; it does not guarantee every55m route can be planned within100ms, and it cannot authorize a >32m suffix reconnect merely because the terrain is traversable.

An independent controlled counterexample retained the actual native planner, original terrain and real Physics. A single real host pause after the first native slice caused default mode to reject an UNKNOWN probe without any goto, body displacement or visit credit. The same pause with the actual food configuration independently confirmed a short endpoint, physically walked it, then freshly planned the remaining return and reached the exact anchor with zero water contact. This reproduces the mechanism, **not the exact cloud failure**: the original CI did not print probe status, elapsed/stopReason, pose or reconnect extras, so those exact failure-time details remain unobserved.

The correction is confined to the offline fixture. It uses the actual food configuration, forces its first real long-path result only downward to UNKNOWN while retaining a bounded prefix as a hint, and requires a subsequent independent native success before each physical leg. It retains the same pond/start position, original12s test and10s leg limits, original100ms probes, real native planner/Physics, exact final anchor, zero water contact and unchanged visit/order counts. A separate all-UNKNOWN case requires zero movement/control activation and zero invented visits. No production code, clock, default option,500ms retry policy, dependency, formal scenario or gameplay deadline changes.

Final complete offline, clean-checkout, PR/main CI and source-archive consumer results are bound to their own actual commits in release-side `RELEASE_ATTESTATION.json`. The complete24-scenario/32-round full03 remains the unchanged `a22a73a` gameplay result; it is not described as a new gameplay rerun at a later documentation/offline-fixture commit. Runtime core/vendor, formal scenario/harness, lockfile and driver byte equivalence must be checked separately before carrying this game evidence into the source release; installer changes are recorded below.

## First main CI failure and subsequent offline-fixture repair

The [f588 PR CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40065977579) naturally passed its original complete runtime command3327/3327 and setup18/18. The distinct [first main push CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40067331000), attempt1, then naturally failed: **3326/3327 passed,1failed,0cancelled/skipped/todo**, runtime exit1. Its actual checkout is `f588b8bdbc82c41e22d35f9a69802efa4c3487e5`, tree `4dd4fcc07fa59f44e4663508e9ed7ecd154a4004`; installation, lint, typecheck, host74, security6, legacy25, setup18 and tracked-source checks passed. The failing main attempt is preserved independently and was not rerun or relabeled.

The sole failure is `formal14 the original native graph physically completes the recorded ascending dirt-path leg without disabling the support guard`, in `test/house-dirt-path-graph-physics.test.js`, with code `dry_graph_route_lost`, duration230.039348ms, and production stack at `houseSurfaceGraph.js:1964`. The complete original CI log contains no failure-time native goto error, path update, blocked-edge or body/tick telemetry. The exact first cause remains **NOT_ESTABLISHED**; the duration alone does not prove a scheduling or fixture cause. Any later controlled counterexample is mechanism evidence, not an exact replay of this cloud failure. The original typed failure receipt SHA256 is `460b0dffac13699d106469024e418e6c158b775afd7113ade6bb5a01d52f9fe8`; complete decoded job log SHA256 is `4cdc7b0b2f7d7edc13a9a37caef3fcd9d9448576f436cf14296ec690dd4df520`.

An independent controlled counterexample used the original f588 source, real native AStar and Physics, and exactly one real45ms scheduling pause at the first follower compute-start sample in each case. No native result, probe, actor, Physics, world or budget was replaced. The original native slice genuinely returned `partial` with0path nodes; raw goto resolved while actualArrival=false, after which the graph retained a `dry_graph_move_unconfirmed` blocked edge and failed `dry_graph_route_lost` with the body airborne. With the same pause, the already-existing production `settleNativeGoto` adapter waited1732ms, confirmed the original target cell with the body grounded, and the graph completed with visits2. The controlled two-case command naturally exited0. This establishes a missing-fixture-settlement mechanism, **not an exact replay or established first cause of the cloud failure**. The original single-case fixture also passed on this host without the controlled intervention.

The test-only correction connects the formal14 fixture's `actualnativegoto` to that same existing production adapter using the graph's unchanged absolute deadline. It retains the original terrain/start/velocity/checkpoint, native planner and Physics,20s test timeout,12s leg limit, support guard, exact target-cell/grounding/visits2 and zero-water requirements. A new explicitly modeled empty-partial event still invokes the real native goto; early resolution alone earns no arrival credit. Another modeled case cancels during actual native motion and must reject `cancelled`, clear controls, keep visits1/current at the origin and create no target node. The earlier food-fixture all-UNKNOWN no-motion/no-invented-visit regression remains unchanged; partial or UNKNOWN is not upgraded to reachability or arrival. Only the single offline test file changed fromf588; production core/vendor, formal scenario/harness, dependencies and game/action budgets did not change. Targeted tests naturally pass3/3; the subsequent original complete full10 is recorded separately below.

Subsequent code freeze: `264683ad461329a1f6b33849c97fb4b9bb400a84`; reviewed repair scope: only the formal14 offline fixture: use the existing production native-goto settlement adapter, with explicit initial-empty-partial and cancellation regressions. Code-freeze manifest:874files, sourceHash `19fb4ebb504bad54b9e64eb6ca8076db2a2013eb568c4915993ce5a536c13944`. Original complete full10: **3329/3329 PASS, natural exit0,0fail/cancel/skip/todo**; runtime count: 3329. The complete runtime naturally finished in475454.575709ms. All seven original offline commands naturally exited0 on the same264683/19fb freeze: runtime3329/3329, host74/74, security6/6, legacy25/25, setup18/18, lint and typecheck. Each receipt binds unchanged commit/sourceHash, sourceChanges[], clean tracked state, no forced exit and no process intervention. The final five-document release commit, source manifest, fresh clean/archive consumers, privacy and new exact-final-tree PR/main checks require new actual receipts; no f588 receipt becomes a pass for a new source.

The original a22/full03 public24-scenario32-round records remain unchanged and retain their original commit. Production core/vendor, formal scenarios/harness, locks and game/action budgets must have explicit byte-equivalence evidence before carrying that historical gameplay evidence to a test-only repair release. A change to production or those formal bytes would require a separate acceptance decision and must not be hidden as a documentation or fixture delta.

## PR20 first CI failure and fixture-contract corrections

The [first PR20 CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40071530091), attempt1 at `39e6f62764d33e3d6ecd6ded83769c83cad6abce`, naturally completed the original runtime command with **3325/3329 passed,4failed,0cancelled/skipped/todo**, exit1 in1155989.488585ms. Its synthetic checkout `14377d5be127c93b44a487b9429588f9c19355b8` has the exact head tree `495ede3f71c312b1b260da551a8542f0cf5c2546`. The formal14 original and both added regressions passed. Setup18,host74,security6,legacy25,lint,typecheck and tracked-file checks also passed. Full10 and the39e6 clean/archive consumers passed locally; those results do not override this separate cloud failure. The complete original log and all four failure windows remain retained; no rerun replaces that attempt.

| Original failing check | Evidence-backed fixture correction | Preserved contract |
| --- | --- | --- |
| Long observed-leg baseline expected deadline exhaustion but rejected early as `dry_graph_move_unconfirmed` | Use the existing production `settleNativeGoto` adapter with the original graph deadline; add explicitly modeled empty-partial cases for both old and corrected graph versions | Original corridor/start/checkpoint, native motor/Physics,50ms scheduler,26s test limit,22s leg budget,old15s cap,exact grounded target,visits2 and zero-water checks |
| Existing-branch food detour returned `dry_graph_probe_inconclusive` before goto | Separate explicit conclusive/UNKNOWN probe protocol models from the real native-search food-caller recovery test; invoke existing `advanceFoodFrontier` recovery and actual native return-to-root within one original6s budget | A conclusive branch selection must issue branch as first goto then reach camp; the second fresh UNKNOWN must reject before any motor/visit credit with either hint setting;12s test and100ms probe budgets remain unchanged |
| The limit test configured for up to three scheduled interruptions fulfilled instead of rejecting; the actual frame sequence was unobserved | Schedule the declared threat after native goto registration and require three distinct production survival leases, with the first two defenses completed and ownership restored before the next preemption | Original5000ms move deadline,at most two recoveries,three goto attempts,third actual-frame rejection,zero completed moves and route progress |
| Finite self-defense returned the expected deadline-error code but failed the external[500,1500) elapsed assertion; the original elapsed value was not logged | Use one controlled Date/timer scheduler at the original20ms scheduler/50ms native Physics ratio, plus an independent real host watchdog; check captured original deadline and guard observation time | Original600ms leg deadline and owner/profile closure,12s test metadata,native AStar real performance clock,no graph visit credit or late motor writes |

A controlled real45ms pause at the first native follower compute start produced a genuine empty partial: raw goto rejected the long-leg baseline as unconfirmed after1285ms; the production adapter under the same intervention kept the old15s deadline failure at15002ms and let the corrected graph physically arrive at17064ms. A separate controlled1600ms host stall made an external deadline measurement1889ms while the captured production leg deadline remained600ms and visits stayed1. Three explicitly coalesced requests shared one actual defense lease; the corrected limit test instead observes three distinct leases and refusal of the third preemption. These are controlled mechanism counterexamples, **not exact replays of the original CI**. Its missing native/body/frame telemetry leaves the four precise original first causes UNKNOWN.

The repair changes only three offline test files. It does not change production core/vendor,formal scenarios/harness,dependency trees or game/action budgets. Against a22, core executable files are byte-identical with the explicit exception that core/README.md contains later release documentation; the whole core directory is not byte-identical. Probe models are explicitly labeled and cannot establish real AStar reachability; the native food-caller case retains real AStar/goto/Physics and only observes the physical camp/resume boundary, without claiming food discovery or a new graph visit. The subsequent code freeze is `14b9ac5ee0dc413076414324476c6ef9756781fc`,874files,sourceHash `6a1c7b63189fb900d2c69e02990afa492ace25b941356ffc40508f65973a16d8`. The original complete full11 naturally passed **3335/3335**,0fail/cancel/skip/todo,exit0,in475088.889666ms. All seven original commands naturally exited0 on this same freeze: host74/74,security6/6,legacy25/25,setup18/18,lint/typecheck and complete runtime3335/3335. Receipts bind unchanged commit/sourceHash,sourceChanges[],clean tracked state,no forced exit and no process intervention. The final five-document commit requires its own fresh clean/archive consumers,privacy and exact-final-tree PR/main CI; those results are bound separately by the release attestation.

## Subsequent offline checks and original download failures

**Installer code-freeze full9 checks passed.** Installer code freeze (`INSTALLER_CODE_FREEZE`) is `8f324745527b7b13e6553b57c11af3309ebd9871`; full9 runtime naturally passed **3327/3327**, with0fail/cancel/skip/todo, in473583.334084ms. Installer-specific tests naturally pass18/18 (14top-level plus4child tests) at this code freeze. The same8f full9 host command naturally passed74/74, with lint/typecheck, security6/6, legacy25/25 and setup18/18 also naturally passing, source unchanged. The final documentation/release commit is recorded separately in the external attestation. Publication additionally requires new final-commit clean source/archive consumers, privacy and PR/main CI to complete; their results belong in the final release-side attestation, not in the historical a22 game total.

00783 full8 naturally passed the original complete runtime command3327/3327 with0fail/cancel/skip/todo; host74/security6/legacy25 and lint/typecheck passed on that frozen source. A fresh exact0898 source checkout independently passed its original locked installs and complete checks, including3327/3327 runtime. Those are historical source snapshots, not new installer or archive-download acceptance. The [0898 PR CI run](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40063704497) completed successfully at05:07:09 UTC, original runtime3327/3327 with0fail/cancel/skip/todo; actual checkout `2516918a27784fde8b62fe7022a4b0b9a9efd4c2` has tree `833b86304df69bf85325e21461fb2af400be36de`, exactly equal to0898. This historical CI does not certify the new installer commit; the original first cloud failure remains unchanged above.

`npm ci --ignore-scripts` skips dependency installation lifecycle scripts, not every possible later dependency bootstrap. In the fresh0898 host suite, the first Electron import printed “Downloading Electron binary”; path.txt/dist appeared afterward and the host command naturally passed74 tests after258.7419s. The path was the existing native-migration test importing character-service, which imports Electron. This is observed external-resource work inside a source-level test, not a measured per-HTTP delay, Java startup, GUI/provider acceptance or a network-free test guarantee. Downloaded dependencies remain consumer-local and excluded from source assets.

Both independent fresh0898 archive-consumer attempts retained their original installer deadline and naturally failed before any game:

| Attempt | Setup wall seconds | Original download total deadline | Setup exit | Fresh official install / offline recheck / game |
|---|---:|---:|---:|---|
| archive consumer02, first attempt |301.574803959|300s|1, natural, no signal|Not completed / not started / not started|
| archive consumer03, second attempt |301.347055500|300s|1, natural, no signal|Not completed / not started / not started|

Each retained the original timeout stderr, empty setup stdout, input hashes and an independent empty runtime root; no cache from the first attempt was reused. Partial JDK bytes were observed increasing at selected times, below the declared199754598-byte archive. These finite samples establish transferred data at those moments; they do not establish uninterrupted liveness, a final complete archive/checksum, or whether vendor throughput, throttling, local transport or another network condition caused the deadline to be reached. Neither failure is a successful consumer or gameplay verdict.

The installer repair changes download policy only: header wait300s, stream inactivity300s reset by received data, fixed total900s; no automatic retry. A continuing body transfer can pass the old absolute300s boundary while remaining bounded by idle and total limits. The setup-specific original `npm run test:minecraft:setup --prefix electron` is included in the offline CI/check list, with controlled timers, stream cases and real temporary-file assertions. On the installer code freeze it naturally passed18/18 (14top-level plus4child tests); the complete full9 runtime3327/3327 and host74/74 have naturally passed. Subsequent final consumers/CI still require their own exact-source receipts. Runtime core/vendor, formal scenario/harness, dependency locks and all game/action deadlines remain separate unchanged anchors. The next frozen source and fresh full-chain receipts are required; two old download failures will not be overwritten by a later success.

## Later PR20 quarry-entry failure and direction-independent defense fixture

The [later PR20 CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40075916022), attempt1 at head `4f411f11ad47f411ba6c1b1660490fd01bf3d053`, naturally completed the original runtime command with **3334/3335 passed,1failed,0cancelled/skipped/todo**, exit1 in1155904.464257ms. Its synthetic checkout `133dc5b9c8e85d355e04aac7cea1afa57bc5ede3` has the exact head tree `4af8e59d91662fcb802e3cb447100e2782de9d1f`. The single failure was `entry discovery retains its original deadline and native profile through its captured defense`, duration19974.542405ms, `house_quarry_entry_pending`. Failure-time probe results, body pose and exploration graph were not logged, so the exact original cause remains **UNKNOWN**. Full11 and the passing local4f411 archive/source consumers remain separate historical results; they do not override this cloud failure. The original attempt and full log are retained without rerunning or replacing that attempt.

The original fixture makes stable mining ground available only at x>=4 while the defense case implicitly expects entry discovery within its unchanged eight actual advances. Native finite probes may legitimately be UNKNOWN and exploration may choose another direction. Separate controlled experiments use the exact original case/fixture, native goto/AStar/Physics and assertions: only finite read-only native probe results toward target.x>0 are downgraded to timeout/UNKNOWN after the actual native search. Search parameters and paths are retained; no result is upgraded, no UNKNOWN grants a goto and no body coordinates are written.

| Separate offline observation | Exit | Actual result | Boundary |
|---|---:|---|---|
| Corrected observer, unchanged original fixture |0,natural|1/1;6.585s wrapper; one actual defense; entry(16,64,16), one cobblestone and grounded camp return|A passing independent observation, not a CI replay|
| Controlled +X UNKNOWN, original asymmetric ground |1,natural|12.623s;8 actual advances,graph9 visits,0dig; camp→(-16,16)→…→(-128,128),then entry_pending|Expected negative demonstrating an unsupported directional assumption|
| Same controlled UNKNOWN, stable perimeter only |0,natural|1/1;6.660s; actual entry(-16,64,16),one cobblestone and grounded camp return|Only stable condition changes to max(abs(x),abs(z))>=4; original movement, limits and assertions remain|

All three completed experiments captured one actual defense, distinct task/survival lease tokens, the same captured native movement profile and the same original surface-move deadline across defense. Each discovery series retained one original deadline, maximumAttempts8 and actual moved outcomes. Cleanup removed the isolated temporary fixture, detached the task, cleared the goal and left all controls false. These comparisons establish a fixture mechanism, not the original cloud failure's exact first cause.

The first diagnostic observer itself failed while serializing an entire Movements/registry object; this was an instrumentation hook failure. It preserved the production trace before original cleanup was skipped. Its owned offline Node was then explicitly stopped with SIGTERM, exit-15; a later read-only process check confirmed it absent and the uniquely trace-hash-matched owned temporary fixture was removed; the first wrapper's naturalExit=true field was incorrect and is retained with a separate typed correction/cleanup record. That attempt is neither an original-case PASS nor a game failure. One explicitly authorized corrected observer execution used typed profile projections and finally-protected original cleanup, then naturally passed. Historical graph references from the first observer are not presented as immutable snapshots. There was no repeat-until-green series.

The narrow repair changes only `test/house-quarry-entry-engine.test.js`. Only the captured-defense case enables stable ground around the camp, leaving existing asymmetric and all-sand coverage in place. It preserves every original assertion and the original **30s test limit,120s discovery deadline,eight attempts and native5ms Physics interval**, and adds explicit assertions for the original frame/profile, distinct leases, unchanged move/discovery deadlines, native material extraction outside the sand camp and grounded return. No production core/vendor,formal scenarios/harness,dependency locks or game/action budgets change.

Historical quarry-repair code freeze: `057f5ce1fb30263b93b7f62512837c14bfda12a4`,874files,sourceHash `0fc1d15a9dcaa8cbaf238487ed237c39debec2f4af9e163b3e3a140c232097d8`. Complete original full12 naturally failed **3333/3335,2failed,0cancelled/skipped/todo**,exit1,in472577.846041ms. The other six original checks naturally passed on that same unchanged freeze: host74/74,security6/6,legacy25/25,setup18/18,lint and typecheck. The repaired quarry-defense case passed; the two separate failures were saved05 slope planning and the pond return’s second fresh probe. A later five-document release commit requires its own fresh consumers/privacy/exact-final-tree PR and main CI, recorded by the external attestation. The a22/full03 gameplay result remains its original24-scenario32-round run, not a new gameplay run of this test/documentation identity.

## Retained full12 failure and separated pond/native-planner contracts

Original full12 on `057f5ce1fb30263b93b7f62512837c14bfda12a4` /874files/sourceHash `0fc1d15a9dcaa8cbaf238487ed237c39debec2f4af9e163b3e3a140c232097d8` naturally completed **3333/3335 passed,2failed,0cancelled/skipped/todo**,exit1,in472577.846041ms,with unchanged source and no forced exit/intervention. The other six original commands naturally passed on that exact freeze. The quarry captured-defense case passed and remains a valid narrow repair; neither its targeted results nor the previous full11 overwrite this whole-suite failure.

| Original full12 failure | Actual result | Original-cause boundary |
|---|---|---|
| saved05 native one-step slope fixture | 59.979833ms; original preplanning returned`noPath` where the assertion required`success` | Original failure lacks complete native search telemetry; exact cause remainsUNKNOWN |
| Pond food detour,#2603 |758.632458ms,`dry_graph_probe_inconclusive`;returnToAnchor2104→observedReturnMove1537→nativeMove1083|Original TAP did not retain observedProbe/body; exact cause remainsUNKNOWN |

The pond’s one transparent independent observation naturally passed1/1: an actual short hint was reached,then the camp-selector and independent execution probe both finished conclusive,and the original goto/Physics returned to camp with water0/visits1. A single controlled comparison only downgraded the second fresh camp-probe result from the actually reached hint to UNKNOWN,after the preceding selector genuinely succeeded. It naturally failed with the same2104→1537→1083 chain after825.736291ms; only the first hint goto occurred,body stayed grounded at that actual hint,water0/visits1,no camp credit,goal/controls cleared. The original helper already models its first long native slice as UNKNOWN regardless of whether the underlying native slice is partial or success. These observations explain a valid failure mechanism,not an exact replay of full12 scheduling; enabling reachable hints never removes the independent second-fresh-probe requirement or grants500ms recorded-return privileges.

A separate saved05 comparison observed the original default path postprocessor changing live pending AStar node data from integer cells to half-block centers during a real nonempty partial. With `optimizePath:false`,the real12ms pause still produces nonempty partials while pending/best/path cells remain integer; native planning finishes success and Physics reaches the original target,grounded,visits2,water0. The first diagnostic script incorrectly predicted that the default-optimization comparison must end noPath; it actually ended success,so that diagnostic naturally exited1 with2/3 expectations met. That false prediction and its raw receipt remain retained. Observing a mutation is not proof that it caused the precise earlier suite failure or that every such search must fail. The fixture repair changes only its read-only preprobe to match the production `optimizePath:false` policy,and adds the real-partial invariant regression without changing planner1000ms/10ms,100-iteration,8s test or physical-route assertions.

The pond repair separates three contracts,keeping the original all-UNKNOWN zero-movement case byte-for-byte:

1. **Explicit modeled conclusive probe protocol plus real physical route.** Probe statuses/paths are a named protocol model,not proof native AStar always finishes in100ms. Original installed goto/AStar and Physics still physically reach the short4–16m hint and exact camp around the same pond. Every old positive assertion remains: first short noncamp goal,newest independently consumed successful proof per leg,actual camp,water0,visits/order1; grounded return is additionally checked.
2. **Deterministic modeled second-fresh UNKNOWN rejection.** After real physical hint arrival,the modeled selector succeeds and the independent execution probe is UNKNOWN. The camp leg has no motor,no arrival/visit credit; actual floating origin,owned profile while probing/moving,restored original prior profile,grounded dry body and checkpoint identity are checked. A100ms quiet window checks no late goal/control/motor,without overwriting body or forbidding natural inertial drift.
3. **Modeled initial long UNKNOWN hint plus subsequent genuine native-probe safety integration.** The initial hint downgrade is declared; later native statuses are not upgraded. Success requires all physical positive assertions and typed`NATIVE_RETURN_CONFIRMED`. Only exact `dry_graph_probe_inconclusive` plus conclusivefalse,finite slice/elapsed/wall facts,correct ownership/profile,unchanged refused floating origin and no unverified motor/CP credit may yield typed`NATIVE_PROBE_UNKNOWN_SAFE_STOP`. Unrelated owner,guard,leg-timeout,assertion or conclusive-noPath failures are rethrown. A safe UNKNOWN stop is a successful safety-contract check,**not a completed pond playthrough,food production or vanillaE2E PASS**.

A case-only use of the existing production native-goto settlement observes early native resolution under the original leg deadline and expected stop/timeout callbacks; it adds no retry or budget. Test limits remain12s,legs10s,the original100ms probe and guarded500ms recorded-return policy,and real10ms Physics scheduling. The first candidate group naturally3/4failed because a new assertion incorrectly required the graph profile to remain installed after the original method correctly restored its prior profile in finally. That failure is retained. After explicit correction,the one corrected group naturally4/4passed with0fail/cancel/skip/todo in7982.739625ms; its later-genuine-probe outcome was`NATIVE_RETURN_CONFIRMED`. Targeted candidate success is not a whole-runtime result.

Latest code freeze: `1f3d03ff3e9b2711ca75c8c4bc0c87d91a34bfe7`,874files,sourceHash `722e3143c519a0feaf14fc518814d103f8ebea8c32addf7d58e6653ca6876aad`. Complete original full13: **3338/3338 PASS，自然 exit0，0 fail/cancel/skip/todo**. Same-freeze seven-command result: **全部自然 exit0：runtime3338/3338、host74/74、security6/6、legacy25/25、setup18/18，lint/typecheck通过；874文件源码前后不变**. Full13 runtime took477270.260875ms; its explicitly modeled-initial-hint/later-genuine-probe integration actually reported`NATIVE_RETURN_CONFIRMED`,water0,visits1. No production core/vendor,formal scenario/harness,dependency lock or game/action budget changes; core executable equivalence explicitly excludes its later README documentation. The a22/full03 vanilla24-scenario32-round result retains its original identity. A later five-document release commit and fresh consumers/privacy/exact-final-tree PR/main CI require their own completed receipts and external attestation.

## Known efficiency limit retained after passing full03 E2E

**Final scope: observed recovery history within an overall passing E2E.** After last incidental iron loot at03:10:14.895 UTC, coal1 repeatedly returned toward front42,17,13, reported not_arrived and ran two separately counted unstick actions. They genuinely climbed and returned but produced no coal. At03:21:51.997 UTC the unchanged agent abandoned the unreachable front under its existing80-return-leg bound and started a new mine. This roughly11min37s interval remains a real efficiency limitation. Public log calls do not directly sample the private return counter.

A bounded512-block disk snapshot saved at03:11:52 UTC, read at03:16:56 UTC, shows the old front's support missing. An independent offline native planner/Physics probe from a controlled representative start42.5/17/12.5 reproduces the same class of failure: strict GoalBlock42/17/13 returns `not_arrived` in95ms, while the legal lower standing tile42/15/13 is reached in571ms and settles on ground. The probe used unchanged production code, kept all outside blocks UNKNOWN and attempted no block mutations. A saved snapshot and a chosen starting centre are evidence of the mechanism; they are not exact live subblock telemetry or proof that every retry had identical geometry.

After abandonment the new mine descended toY16 and first produced incidental iron, which did not substitute for coal. At70min the original inventory actually showedcoal1; construction resumed and the final E2E passed all original contracts. This observed recovery cost creates no arbitrary extra performance gate for the source developer preview. Standability checks and coordination of the two recovery counters remain improvement opportunities; the pass is not a claim of no known limitations. Earlier failed/interrupted results remain unchanged.

## Final E2E same-run contract

E2E naturally completed in4269204ms (71m9.204s), alive with serverhealth20. Final independent home readback is95/95, all furniture present, tableUsed/furnaceUsed/chestUsed/bedUsed true,32table and9furnace native target-bound interactions, iron_sword/iron_pickaxe/shield1each. Generator regenerated8 and collected/reported8 from empty correct output via4+4 transfers. Smelter produced5 recipes, collected/reported4 via four1-unit withdrawals, with one extra ingot left in output; its minimum contract is4, not exactly4 produced. All7smelter parts remain present.

All four injections fired/recovered; actual deaths2 match the two planned death injections, with0additional deaths observed. Hook recovery markers20/14/12/20seconds describe the injection observer. They must not be called full actual recovery times: first recover_drops attempt timed out at240s, then try2succeeded after34.660s and resumed the house task 277050ms (4m37.050s) after death; second actual pickup succeeded in7452ms (7.452s) before its20s hook marker. Internal earlyhome goal_done did not replace the final95/95+gear readback. Original unique E2E final JSONL line3185 equals its summary; cleanupconsoleexit0/save/close/logClosed true, not forced. The [public result record](docs/validation/2026-10-24/validation-results.json) retains typed quantities and evidence hashes.

## Previous failed baseline

At the previous main snapshot the raw original verifiers returned 21 PASS and 3 timeout FAIL among 24 cases. The failed cases were iron mining, diamond mining and E2E; some raw PASS verifiers had coverage gaps now addressed. These are retained as previous results, not inherited passes for the new snapshot.

The old E2E ended after 300.0149 minutes with 7 deaths (two injected and five additional), generator 8/8, all four injections recovered, smelter incomplete, final house 59/95 and required gear absent. It remained alive at the end. Late autonomous mining recovery occurred after a 125.334-minute interval with mixed mining/supply/sleep/combat/death/tool activity; this supports degraded progress, not a claim of permanent deadlock or pure idle. The incomplete iron fixture prevents attributing that old iron timeout solely to behavior under the intended complete veins.

The new code repairs observed mechanisms and acceptance gaps. Only the new terminal results can establish whether the repaired full contract passes.

## Reproduction with existing CLI

From `electron/minecraft-runtime`, `node tools/run-scenarios.cjs --help` prints usage and all 24 scenario names, then returns **2** under the existing CLI help contract; it starts no Java server. The local installer's `--help` returns 0. A real scenario run still requires natural exit **0**, matching terminal results and clean save/close evidence. Help exit2 is not a gameplay verdict.

Use the verified Node22.22.0/npm10.9.4 environment and install runtime dependencies plus Java21/vanilla1.21.8 as described in [README.md](README.md). Other newer Node/npm versions have not been verified. Accept the Minecraft EULA before running the game. The source asset contains the ordinary scenario/regression CLI; no private driver or local absolute path is required.

The standard regression command, run from `electron/minecraft-runtime/`, preserves all full repeats but uses uniform setup seed101 and the public scheduler's suite order:

```sh
npm run regression -- --accept-eula --suite full --seed 101 --parallel 2
```

The following complete24-command script preserves each formal scenario's original repeat count, difficulty, timeout, fixture, fault contract and setup seed (E2E1; all others101). Start it from the extracted source repository root. It creates one new unique batch name and24fresh worlds, with32rounds in total. Every line uses the existing public scenario CLI; no private orchestrator file is needed.

```sh
# Start from the extracted source repository root.
cd electron/minecraft-runtime
mc_validation_batch="recheck-$(date -u +%Y%m%dT%H%M%S)-$$"
mc_validation_failed=0
npm run scenario -- --accept-eula --scenario e2e-flat --runs 1 --seed 1 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario homestead-natural --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario mobfarm-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario homestead-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario machines-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario branch-mine-iron-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario collect-logs-flat --runs 3 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario night-bed-flat --runs 2 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario collect-logs-natural --runs 3 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario cobblegen-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario cobblegen-hopper-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario smelter-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario canefarm-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario carpetdupe-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario fishing-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario raildupe-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario ironfarm-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario nether-quartz-given --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario materials-cobblegen-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario branch-mine-redstone-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario branch-mine-diamond-flat --runs 1 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario night-bunker-flat --runs 2 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario farm-flat --runs 2 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
npm run scenario -- --accept-eula --scenario ranch-flat --runs 2 --seed 101 --batch "$mc_validation_batch" || mc_validation_failed=1
test "$mc_validation_failed" -eq 0
```

This copyable script runs serially in the formal campaign's priority order. It continues after a failed child while retaining the failure flag; the last command exits nonzero if any child failed. Do not replace a failed round with a later rerun and call the original batch passed. Keep each scenario's `summary.json`, every `run-NN.jsonl` terminal `result`, CLI exit code and save/close receipt. The actual full03 formal run uses a dynamic six-worker queue in this same priority order: the first six are E2E, natural homestead, mobfarm, flat homestead, machines and iron mining; each freed worker immediately starts the next queued case. Serial execution and the standard regression scheduler have different host load and timing, so they reproduce the per-case contracts rather than identical scheduling.

The formal driver and independent final importer additionally bind source/driver hashes, expected round counts and terminal result consistency. They are local review tools, not consumer dependencies. The public validation result must identify the tested frozen source and any later documentation-only release commit separately; record the downloaded asset manifest/SHA256, keep gameplay/acceptance source unchanged during a replay, and compare final output with this per-round result contract. Individual scenario invocations create no automatic combined `regression.json`; all32rounds must be reconciled before declaring the script's complete gameplay acceptance. Never reuse the original formal batch name or an existing result/world directory: the CLI refuses overwrite, and every manual rerun needs a fresh unique batch.

`--seed` controls setup RNG, not terrain generation. Repeated rounds retain the existing default reuse lifecycle and fresh setup; worldgen seeds remain in the public scenario definitions. Limits, supplied resources and four E2E faults are not adjusted by this script.

## Final receipt status

| Required receipt | Value |
|---|---|
| Historical full3 / full4 | full3 3180/3180 exit0; full4 3274/3275 exit1, natural closure and unchanged source |
| Current raw runtime full7 count/exit/natural closure | PASS3326/3326, fail/cancelled/skipped/todo0, exit0, natural closure; sourceChanges[] |
| Exact-a22 host lint/typecheck/tests/security/acceptance | PASS74/74,6/6,25/25; lint/typecheck exit0, unchanged source; earlier70/74 EPERM environment failure retained |
| Formal full end / totals | 2026-10-24 03:27:27.151 UTC;24scenarios32pass/0fail;2planned/0extra deaths; full table above |
| Every summary matched to its final JSONL result | PASS32/32; importerALL_PASS/issues0 |
| Post-campaign frozen manifest/source match | PASSa22/2b47/867unchanged; driverunchanged |
| Clean extracted source archive install and documented-entry check | Recorded separately in release-side `RELEASE_ATTESTATION.json` |
| Public privacy/provenance review, exact asset manifest and SHA-256 | Recorded separately in release-side `RELEASE_ATTESTATION.json`, `SOURCE_MANIFEST.json` and `SHA256SUMS` |
| Release scope choice | User-confirmed source developer preview |
| Version/tag / publication | v0.1.0-alpha.1 / final asset+install+privacy release receipts recorded separately |

Raw worlds, complete logs, accounts, personal configuration and local absolute paths are not part of the public asset. Final public evidence should contain the minimal sanitized per-round result and hashes needed to assess the claim, preserving failures and UNKNOWN/PENDING fields instead of replacing them with zeroes or assumed success.
