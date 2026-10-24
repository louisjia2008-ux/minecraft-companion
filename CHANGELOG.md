# Changelog

## v0.1.0-alpha.1 — source developer preview

Scope: **source developer preview v0.1.0-alpha.1**. Tested freeze: `a22a73a4a7294ab5409b6e74ee882b2603ab528b` (867 files, sourceHash `2b47b336ab2279cc27e12ebebf418e508e557e5b09ce4b35a91f97690bf3e73f`). The original complete runtime full7 naturally passed 3326/3326. Formal full03 naturally passed all24scenarios/32rounds, 2026-10-24 02:15:09.845—03:27:27.151 UTC, exit0, with matching final summary/JSONL and unchanged source/driver. Exact source archive, clean extraction/install, release commit and asset checksums are recorded separately at publication.

Preserved offline failures and interrupted campaigns are detailed in [VALIDATION.md](VALIDATION.md). In particular, full6 naturally failed 3324/3325; full7 passes only after a test-only clock correction with production and original budgets retained. Full02 has30 passed rounds and2 interrupted rounds, and does not supply passes to full03.

### Core capabilities in scope

- Independent single-loop core with explicit goals for homestead, resource gathering/mining, farming, ranching, Nether quartz, fishing and device construction.
- Optional default autonomy for homestead, food stock, a hopper cobblestone generator and an automatic smelter; other goals remain explicit API/scenario capabilities.
- Shared survival, recovery, night rest and home maintenance around the active goal. The new core remains separate from the Electron host's legacy task engine.

### Repairs

- Distinguish actual mining/material progress from revisiting known routes, repeated endpoints and cave turns; add bounded route recovery and route-floor repair confirmation.
- Separate device positioning from material-stage mine context; confirm low/partial-height physical arrival without treating a still-settling body as already arrived.
- Extend injured provisioning through the gap before food enables health recovery, while preserving survival preemption and cancellation.
- Recheck completed home structure, furniture and required gear; protect the home from material gathering and arrange repair/replacement when observed state changes.
- Reconcile retained legacy fixture dependencies, native hurt/hostile semantics and lifecycle cleanup. Offline fixture repairs retain the production owner/lease boundaries.

### Iteration2 repairs and controlled preflights

- Bound all goNear direct/fallback legs by one original total deadline, include path_timeout in existing fallback classification, and keep parent cancellation authoritative even with delayed native acknowledgement.
- Adapt only validated loaded/open/consistent two-half doors without changing world collision geometry; repair initial and native partial paths and clean up only owned wrappers/listeners across bot reuse.
- For one unfinished collector hopper obstructed by a visible in-range bat, make one native hit and verify the cell actually clears before one replacement attempt; do not invent a kill, drop or progress. XP orbs do not block placement.
- Handle CLI SIGINT/SIGTERM by quiescing and joining work, preserving the interrupted false result and first-signal exit status, and confirming console stop/save/close. Keep batch cleanup failures separate from already-closed round JSONL.
- A fresh real-server door traversal fixture and a separate real CLI interruption fixture passed their narrow contracts on e6. The interruption run remains gameplay-interrupted/false; neither is a formal scenario pass.

### Iteration3 bounded mine rejoin and maintenance

- After an off-route native no_progress, derive at most 4 loaded safe cardinal ascent legs to the original tunnel cell under one 20s total budget. Native planner success alone does not establish executable movement. Preserve root cancellation, hazards/UNKNOWN/real body geometry, no mutation and owned movement cleanup.
- Keep home maintenance's body ownership bounded even while unarmed material gathering continues inside a long awaited native action; let the existing ordinary goal resume.
- Preserve the observed full6 native-food timeout. Correct only its test clock to pump the original ideal20ms scheduling/50ms Physics ratio, retaining logical 5000ms/250ticks and an independent real 8s watchdog; production is unchanged.
- New 38/38 mine rejoin, 92/92 related and 17/17 home checks plus an unshimmed native first-watchdog→arrival offline probe are focused regressions, not formal gameplay results.

### Cloud CI fixture correction

- Preserve the first PR CI attempt on07bd: original runtime3325/3326, one pond food-detour failure, no cancelled/skipped/todo. Other original commands passed. The cloud probe details were not logged, so the controlled host-pause counterexample is not called an exact replay.
- Align that offline fixture with the actual survival_food nativeReachableHints policy. Force the first real long-path result only downward to UNKNOWN; require each physical leg to consume its own latest successful native probe, and keep all-UNKNOWN motionless with no invented visits.
- Keep the same native planner/Physics, pond and origin,12s test/10s leg/100ms probe limits, default false option and500ms policy. Production, formal scenarios, locks and the full03 driver remain unchanged. New complete offline/CI/archive receipts are bound independently to the final release source.

### Installer download policy and verification

- Preserve both original0898 archive download failures: independent fresh roots, original300s total deadline, natural setup exit1 after301.5748s/301.3471s, no completed Minecraft installation or game. Partial-byte samples are not proof of continuously healthy networking or a confirmed underlying transport cause.
- Replace the one absolute download deadline with header300s, stream-idle300s and fixed total900s; do not automatically retry. This installer/tooling change is separate from unchanged runtime core/vendor, formal harness, dependency locks and game/action budgets.
- Add the original installer-specific test command to CI. Installer code freeze `8f324745527b7b13e6553b57c11af3309ebd9871` naturally passed the complete runtime3327/3327 and setup18/18 (14top-level plus4child), with0fail/cancel/skip/todo. Final documentation/release identity is recorded in the external attestation.
- Retain00783/full8 runtime3327/3327 and0898 clean-source checks as their own historical results; the0898 PR CI naturally completed successfully at05:07:09 UTC with runtime3327/3327. None substitutes for the next commit's required consumer/CI/publication receipts.
- Clarify that ignore-scripts skips install lifecycle hooks. The fresh0898 host test still triggered Electron's lazy binary bootstrap and naturally passed74 tests after258.7419s; this is dependency work, not GUI/provider or fully network-free acceptance.

### Acceptance changes

- Reject dusk/underground night false positives using independent server day, dawn, surface, health, sleep/bunker evidence and deaths.
- Keep timeout/final brain failure/harness errors authoritative over a passing verifier; preserve server verdict and final status separately; exit nonzero on any failed round.
- Preload and check all setup chunks/commands and independently verify the final ore map, including previously unloaded eastern iron veins.
- Bind E2E generator collection and smelting to fresh correct-source container/player deltas; require fresh machine furnace recipe growth and reject old/preloaded stock or deposits.
- Bind house table/furnace usage to native operations at final furniture coordinates and service-side block/statistic confirmation.
- Require five independently caught-and-picked-up fishing catches, including junk and treasure, and a live zombie in iron-farm verification.
- Cover every registered scenario in full: 24 scenarios, 32 rounds, 100% gates. Preserve original repeat counts and deadlines, resource conditions and E2E faults.
- Join in-flight hooks and bounded readbacks before result closure; release all cleanup resources on errors, guard late native completions, and refuse overwriting an existing batch/world/result.
- Preserve absolute server output offsets across log truncation and serialize identical-response queries.
- Scope ESLint's Node/CommonJS environment correctly while retaining undefined-name enforcement.

### Distribution boundary

This source preview includes only source: project code, lockfiles, tests/limited fixtures, build configuration, licenses/provenance and a sanitized validation summary. Dependencies, Java/server artifacts, worlds, logs, personal configuration and desktop binaries are excluded. No npm package publication is implied by the existing private package versions. The third-party desktop bundle is not distributed while license-variant/notice coverage remains unresolved.

Final gameplay acceptance is24scenarios/32roundsPASS and the historical a22/full7 offline runtime3326/3326PASS. Final release offline and CI results are separately bound in RELEASE_ATTESTATION.json. E2E finishes after71m9.204s with finalhome95/95, requiredgear1each, generator8collected, smelter5produced/4collected, four recovery faults and only2planned deaths. It retains an observed11m37s floating-front retry cost before autonomous new-mine/coal recovery; standability and recovery coordination remain known improvement opportunities. Archive/install/checksum publication receipts remain separate. Historical README/core numbers retain their historical status.
