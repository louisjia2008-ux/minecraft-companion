# Minecraft Companion formal validation

Frozen core snapshot `a22a73a4a7294ab5409b6e74ee882b2603ab528b` passed the complete repair-20261024-full-03 campaign: **24 scenarios, 32/32 rounds**. Every round has matching summary/final JSONL and successful unchanged driver evidence. Each scenario's server has confirmed console shutdown/save. The source hash is `2b47b336ab2279cc27e12ebebf418e508e557e5b09ce4b35a91f97690bf3e73f`.

This report covers a source-only core developer preview. The new core is not wired into the desktop host. Default optional autonomy selects home/food/generator/smelter; other skills are explicit API scenarios. Scenario worlds include prepared fixtures and resources. The campaign does not establish independent unassisted natural-world survival.

Repeated rounds reuse the same bot/world for their scenario, with setup reset and PRNG base+zeroBasedRound*7919; different scenarios have isolated fresh worlds. E2E base seed is1; every other scenario base seed is101. Original frozen deadlines, resources and fault requirements remain in the reviewed source.

Earlier outcomes remain retained: the original snapshot finished with21 passing and3 timeout-failed scenarios; repair full01 had15 passing scenarios/20 passing rounds, one completed mobfarm failure, six interrupted first rounds and five unstarted rounds. Its six interrupted world saves remain unconfirmed. Repair full02 completed22 whole scenarios/29 rounds plus farm round1, totaling30 passing and2 explicitly interrupted rounds; both interrupted worlds have confirmed console shutdown/save. Full02 was stopped for repair and is not a completed suite. This new campaign is evaluated as a complete frozen run; earlier passes never fill missing current rounds.

| Scenario | Rounds | Passed | Deaths | Total measured ms |
| --- | ---: | ---: | ---: | ---: |
| collect-logs-flat | 3 | 3 | 0 | 130428 |
| collect-logs-natural | 3 | 3 | 0 | 163184 |
| homestead-flat | 1 | 1 | 0 | 1284787 |
| homestead-natural | 1 | 1 | 0 | 1576897 |
| night-bunker-flat | 2 | 2 | 0 | 1408063 |
| night-bed-flat | 2 | 2 | 0 | 293132 |
| farm-flat | 2 | 2 | 0 | 1472445 |
| ranch-flat | 2 | 2 | 0 | 259853 |
| nether-quartz-given | 1 | 1 | 0 | 64231 |
| cobblegen-flat | 1 | 1 | 0 | 27106 |
| cobblegen-hopper-flat | 1 | 1 | 0 | 23541 |
| smelter-flat | 1 | 1 | 0 | 95987 |
| materials-cobblegen-flat | 1 | 1 | 0 | 395295 |
| branch-mine-iron-flat | 1 | 1 | 0 | 400018 |
| canefarm-flat | 1 | 1 | 0 | 183376 |
| mobfarm-flat | 1 | 1 | 0 | 372188 |
| carpetdupe-flat | 1 | 1 | 0 | 22241 |
| fishing-flat | 1 | 1 | 0 | 109648 |
| raildupe-flat | 1 | 1 | 0 | 59505 |
| ironfarm-flat | 1 | 1 | 0 | 110250 |
| e2e-flat | 1 | 1 | 2 | 4269204 |
| machines-flat | 1 | 1 | 0 | 1830000 |
| branch-mine-redstone-flat | 1 | 1 | 0 | 807204 |
| branch-mine-diamond-flat | 1 | 1 | 0 | 1068046 |

`validation-results.json` retains sanitized per-round quantities, anchors, house/machine/fault readback and original evidence hashes/terminal line numbers. It contains no raw console/NBT text, account names, process IDs, local paths, installation configuration or command arguments.
