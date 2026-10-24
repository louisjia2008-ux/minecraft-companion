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
| Release version / separate asset identity | v0.1.0-alpha.1; documentation/CI/offline-fixture release commit and archive SHA-256 recorded separately |

The aggregate hash binds its repository-file manifest, not a source-archive checksum. Full03 runs against `a22a73a4a7294ab5409b6e74ee882b2603ab528b` and its 867-file frozen manifest. The sole 4160→a22 delta is `test/house-local-food-frontier-host-physics.test.js`; production bytes and original task/native/host deadlines remain unchanged. The earlier e1→4160 production repair adds bounded off-route rejoin and home-maintenance ownership. Historical batches retain their own source identities. A later release commit/archive with documentation, CI and offline-fixture corrections needs its own manifest/SHA256 with unchanged production/gameplay-harness bytes; no dependency or Java/server bytes enter the intended source asset.

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

Final complete offline, clean-checkout, PR/main CI and source-archive consumer results are bound to their own actual commits in release-side `RELEASE_ATTESTATION.json`. The complete24-scenario/32-round full03 remains the unchanged `a22a73a` gameplay result; it is not described as a new gameplay rerun at a later documentation/offline-fixture commit. Production, scenario/harness, lockfile and driver byte equivalence must be checked separately before carrying this game evidence into the source release.

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
