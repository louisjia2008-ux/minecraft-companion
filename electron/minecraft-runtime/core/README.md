# 新执行核心（里程碑 1）

与 `vendor/server/minecraftTaskAgent.js` 并行的新核心。目前还没有接入桌面应用，先通过场景测试平台独立验证；稳定后再逐项替换旧代理的能力。

## 核心规则

1. **身体只有一个决策点。** `brain.js` 每轮（250ms，或上一个动作结束时）重新读取世界状态，按优先级选出一个行为执行。优先级从高到低：逃离 130 > 防御 120 > 维持（进食）100 > 目标 50。高优先级行为出现时，当前行为通过 `AbortSignal` 被中止，等它真正停下后才启动新行为。同一优先级内不互相抢占。
2. **任务不"恢复"，只重新判断。** 目标（goal）只提供四样东西：`isDone(state)`、`progress(state)` 和 `run(ctx)`，外加一个名字。进度保存在世界里（背包、方块），不保存"做到第几步"。被打断后，下一轮看现状再决定，不需要任何恢复分支。
3. **动作要短，并且以服务端事实为准。** `actions.js` 里每个动作都有超时（以秒计），响应中止信号，并且只在观察到实际结果后才返回 `ok`，比如方块真的消失、物品真的进了背包。进食要求"食物数量减少"和"饱食度上升"两个条件都成立，与回包到达的先后顺序无关。
4. **失败就换目标，不修路线。** 失败的目标进入黑名单（默认 2 分钟），下一轮选择别的目标。寻路设置是保守的：不搭方块、不垫高、不跑酷、避开水、最多下落 3 格。需要这些动作才能到达的目标会被直接跳过，因此不会留下自建障碍。
5. **不会无限重试。** 目标连续 6 次没有进展就以 `goal_failed` 结束，并附带失败原因列表。被生存行为打断不算"没有进展"。生存行为失败后按指数退避（2s → 30s），避免它一直占着身体。

## 文件

| 文件 | 作用 |
|---|---|
| `brain.js` | 决策循环、抢占、进展预算、失败退避 |
| `perception.js` | 当前状态快照（血量、饱食度、背包、附近敌对生物） |
| `confirm.js` | `waitUntil` / `runCancellable` / 可中止的 `sleep` |
| `actions.js` | 寻路、挖掘、拾取、进食、攻击、逃离 |
| `blacklist.js` | 带过期时间的失败目标黑名单 |
| `goals/gatherBlocks.js` | "采集 N 个某种方块"，每次 `run` 只处理一个方块 |
| `behaviors/survival.js` | 逃离、防御、进食（目前只是最简版本，第 2 步会加强） |
| `companion.js` | 把以上组件接到真实的 Mineflayer bot 上 |

## 测试

```bash
# 单元测试（不需要游戏服务器）
npm run test:core

# 真实 vanilla 服务器场景，重复 20 次并统计通过率
# 默认使用 electron/ 下 `npm run setup:minecraft:local` 安装的 Java 和 server.jar
npm run scenario -- --accept-eula --scenario collect-logs-flat --runs 20
npm run scenario -- --accept-eula --scenario collect-logs-natural --runs 10
```

结果写入 `.minecraft-local-test/scenario-runs/<批次>/<场景>/`：每次运行一个 `run-XX.jsonl`（setup 参数、每个决策事件、最终结果），加上一个 `summary.json`。是否通过以服务器自己的物品计数为准（`clear <玩家> #minecraft:logs 0`），不看机器人本地的背包。每个批次使用新世界，每次运行都会重置场地，随机种子写在 setup 记录里，可以复现。

## 里程碑 1 验收标准

- `collect-logs-flat`：和平难度、空背包，20 次中至少 19 次成功采到 10 块原木。
- `collect-logs-natural`：自然地形，每次换一个地点，记录通过率和失败原因，作为参考，不设门槛。
