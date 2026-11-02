# Minecraft Companion

> **正式发布门槛未通过；本轮未打包。`0.1.0` 仅为本轮目标版本，尚无本轮通过验证的发布包。**

面向 Minecraft Java Edition 的陪玩代理，包含独立决策 core、真实 vanilla 服务端场景工具，以及 Electron 桌面宿主与 legacy 任务引擎。本轮版本目标为 **0.1.0**；验证、打包和发布状态以本页的实际结果为准。

新 core 已提供开发者 API 和结构化嵌入入口，**Electron 桌面界面仍默认使用 legacy 引擎**。打包脚本会将 core 源文件复制进桌面包；这不代表桌面命令、暂停、取消、重连等交互已完成新 core 集成验收。当前仍需区分场景验证、嵌入 API 与桌面使用。

项目自有源码采用 **AGPL-3.0-only**。许可证、继承来源与第三方声明见 [LICENSE](LICENSE)、[LICENSING.md](LICENSING.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 当前能力

自主模式默认关闭。用 `createCompanion({ bot, autonomy: true })` 或 `companion.setAutonomy(true)` 启用后，默认只选择 **家园、食物储备、漏斗刷石机、自动熔炉** 四类目标。其余能力的入口如下。

| 能力 | 入口与范围 |
|---|---|
| 家园与默认机器 | 默认自主目标；从空背包建家、补齐家具和铁装备，再采集材料建漏斗刷石机与自动熔炉。也有显式 API 和独立场景。 |
| 耕种与畜牧 | 显式 `farm()`、`ranch()` API / 结构化工具；开垦播种、收获小麦做面包，以及建围栏、引动物入栏和繁殖。未加入默认自主目标卡。 |
| 材料采集 | 显式 `gatherMaterials()` API / 工具；按清单采集、合成、熔炼并存入指定箱子，支持深层铁、红石、钻石和下界石英。默认机器项目也复用采料链。 |
| 下界石英 | 显式 `netherQuartz()` API / 工具，或由材料需求触发；支持造门、进下界采石英、返回主世界。材料采集链还可制作黑曜石和打火石。 |
| 下界远征 | 显式低层 `companion.netherExpedition()` API / 专项场景；寻找下界要塞和猪灵堡垒、收集烈焰棒与凋零骷髅头、和猪灵交易后返程。当前结构化工具目录尚未暴露此 API。**种子 3 的低地要塞仍是已知难点**，不能保证任意地形成功。 |
| 末地 | 显式 `enterEnd()`、`endDragon()`、`endCity()`、`endJourney()` API / 工具；定位要塞、进入末地、屠龙、穿折跃门找末地城。场景给定末影之眼或装备等前提，不代表空包完成全部原版通关资源链。 |
| 刷铁机 | 显式 `ironFarm()` API / 工具；村民脚部埋深 18 格的地下版纳入正式 full。其场景提供材料、僵尸蛋和村民蛋。`villageIronFarm()` 的村庄村民与矿车运输版为**实验性低层 API / 场景**，未暴露为结构化工具，也不属于 full 发布门槛。 |
| 其他装置 | 甘蔗农场、刷怪塔、捕鱼、刷地毯机与刷铁轨机均有显式 API / 专项场景；未全部加入默认自主选择。 |
| 自动恢复 | 各目标共用卡住、掉坑、满背包与死亡后的恢复机制，含旧动作中止、局部退避、卡片冷却与重规划。实际仍可能连续死亡、反复寻路失败或长时间重建；恢复尝试和局部标记不等于任务完成。 |
| 全流程 e2e | 场景专用验收：空包建家后自主建两台机器，并处理两次死亡、满背包和掉坑四项故障。最终同时核对家园、装备、机器产出、恢复与存活；不是下界加末地的完整通关场景。 |

实现说明见 [core/README.md](electron/minecraft-runtime/core/README.md)，架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。嵌入其他宿主可用 `index.js --engine core --data-dir <独立绝对目录>` 或 `createCoreHost`；工具清单、任务终态、取消与重连合同见 [docs/EMBEDDING.md](docs/EMBEDDING.md)。低层 companion API 的接收成功不等于任务完成，调用方须观察真实终态。

## 安装与离线检查

本轮使用 Node.js **22.22.0**、npm **10.9.4** 和 Java **21**。从仓库根目录安装：

```sh
npm ci --prefix electron
```

`postinstall` 会安装 `electron/minecraft-runtime`。逐项执行离线检查：

```sh
npm run lint --prefix electron
npm run typecheck --prefix electron
npm test --prefix electron
npm run test:security --prefix electron
npm run test:minecraft:acceptance --prefix electron
npm run test:minecraft:setup --prefix electron
npm test --prefix electron/minecraft-runtime
npm run test:core --prefix electron/minecraft-runtime
```

完整 runtime 测试与 core 子集分别记录，不能用子集代替完整测试。部分宿主原生物理计时用例会受负载影响：完整命令的原始失败应保留，失败文件单独以 `node --test <文件>` 复跑；复跑通过记为偶发，单独仍失败则作为真实失败处理。不得跳过或修改测试来获得通过。

## 真实服务器测试

固定使用 Java 21 和 vanilla **1.21.8**。若仓库根 `.minecraft-local-test/` 没有对应服务端 JAR，先运行：

```sh
node electron/scripts/setup-minecraft-local.mjs
```

安装工具通过官方元数据和校验和验证下载，默认写入仓库根 `.minecraft-local-test/`。阅读并接受 [Minecraft EULA](https://aka.ms/MinecraftEULA) 后，在 `electron/minecraft-runtime/` 运行：

```sh
npm run e2e -- --accept-eula --sessions 3 --seed 1
npm run regression -- --accept-eula --suite full --seed 101 --parallel 2
```

当前登记 **35 个场景**；full 自动排除唯一实验性 `ironfarm-village-flat`，包含 **34 个场景、42 轮**，每轮都必须通过。采木两个场景各 3 轮；夜间床/地堡、耕种和畜牧各 2 轮；其余各 1 轮。不要用 `--runs 1` 覆盖 full 的重复次数。套件定义见 [scenarios/regression.cjs](electron/minecraft-runtime/scenarios/regression.cjs)。

e2e 默认运行 seeds 1–3，每个 session 是独立服务器与新世界。full 的下界要塞上限 90 分钟、综合下界远征 180 分钟、自然家园 150 分钟、e2e 300 分钟；需预留足够资源与时间。可因内存不足降低并发，但应保留所有要求的种子与轮次。多数场景的 `--seed` 控制 setup 布局；末地场景还通过自己的定义配置世界生成种子，不能统一当作任意自然世界种子覆盖。

下界要塞场景允许“取得目标头颅，或达到规定的 30 次真实凋零骷髅击杀”满足头颅狩猎门槛；其他条件按各场景的 targets 配置执行。`nether-fortress-given` 不要求交易，综合远征另要求交易与相应黄金消耗，均需满足各自返程条件。失败须保留实际击杀数、死亡与卡住原因。

实验性村庄矿车刷铁机可单独参考运行，不计入正式 full：

```sh
npm run scenario -- --accept-eula --scenario ironfarm-village-flat --runs 1 --seed 101 --batch "experimental-$(date -u +%Y%m%dT%H%M%S)-$$"
```

结果位于仓库根 `.minecraft-local-test/scenario-runs/`。e2e 保存 `e2e-<时间>/e2e.json`，full 保存 `regression-<时间>/regression.json`；各场景的 `summary.json` 和 `run-NN.jsonl` 保留终态与原始事件。判断以自然退出码、最终 `result` 和 summary 为准，heartbeat、步骤数、单项 `goal_done` 或局部服务端通过不能替代完整结果。已有批次禁止覆盖。

## 本轮实测

验证日期：**2026-10-31 05:17:50 +08:00**；游戏与离线代码基线：**`b1317e87e3d18c3a186535b1012bef5339ae7c44`**。以下来自本轮结构化报告快照；未完成项不计作通过，未沿用历史数字。本轮尚无包身份。

| 命令（仓库根目录） | 通过／总数 | 其他原始计数 | 结果与退出码 | 耗时 |
|---|---|---|---|---|
| `npm run lint --prefix electron` | 静态检查 | — | PASS，自然 exit 0 | 0分05秒 |
| `npm run typecheck --prefix electron` | 静态检查 | — | PASS，自然 exit 0 | 0分02秒 |
| `npm test --prefix electron` | 74/74 | fail=0 | PASS，自然 exit 0 | 0分02秒 |
| `npm run test:security --prefix electron` | 6/6 | fail=0 | PASS，自然 exit 0 | 0分01秒 |
| `npm run test:minecraft:acceptance --prefix electron` | 25/25 | fail=0，cancelled=0，skipped=0，todo=0 | PASS，自然 exit 0 | 0分00秒 |
| `npm run test:minecraft:setup --prefix electron` | 18/18 | fail=0，cancelled=0，skipped=0，todo=0 | PASS，自然 exit 0 | 0分00秒 |
| `npm test --prefix electron/minecraft-runtime` | 3523/3523 | fail=0，cancelled=0，skipped=0，todo=0 | PASS，自然 exit 0 | 7分36秒 |
| `npm run test:core --prefix electron/minecraft-runtime` | 515/515 | fail=0，cancelled=0，skipped=0，todo=0 | PASS，自然 exit 0 | 0分28秒 |

独立 e2e sessions：**3/3 终态通过**；父命令 **PASS，自然 exit 0**。这里的 seed 1–3 是独立 e2e 批次；full 内的 `e2e-flat` 使用自己的 seed101 运行，不能互相补通过。

| e2e seed | 终态 | 耗时 | 死亡数 | 故障钩子恢复标记 | cleanup |
|---|---|---|---|---|---|
| 1 | PASS | 49分25秒 | 3 | 4/4 | 是 |
| 2 | PASS | 50分57秒 | 2 | 4/4 | 是 |
| 3 | PASS | 117分26秒 | 2 | 4/4 | 是 |

正式 full 计划 **34 场景／42 轮**；当前终态场景 **34/34**，其中整场景通过 **27**、失败 **7**；轮次为 **通过 35、失败 7、未完成 0**。full 父命令：**FAIL，自然 exit 1**。未完成项不计作通过；当前正式失败：`nether-bastion-given`、`end-dragon-given`、`end-portal-natural`、`end-city-given`、`end-full-natural`、`e2e-flat`、`materials-quartz-flat`。

唯一实验性场景 `ironfarm-village-flat`：计划1轮，终态 **FAIL：timeout**；命令 **FAIL，自然 exit 1**。实验结果单列，不影响正式 full 的包门槛，也不能抵消正式失败。

逐场景、逐轮、退出码、偶发复跑和失败说明见 [VALIDATION.md](VALIDATION.md)；当前限制见 [STATUS.md](STATUS.md)，变更见 [CHANGELOG.md](CHANGELOG.md)。较早冻结版本的结果保留其原日期与提交身份，不作为本轮通过证据。

## Electron 包与发布状态

开发现有桌面宿主可在 `electron/` 运行 `npm start`。独立的旧 JSONL helper 入口和数据目录要求见 [runtime/README.md](electron/minecraft-runtime/README.md)；新 core 的结构化入口另见上面的嵌入接口说明。

所有离线门槛与非实验性真实场景通过后，在 `electron/` 运行：

```sh
npm run verify
npm run make
npm run smoke:minecraft-package
```

`verify` 包含检查、构建、包审计和冒烟；`make` 的当前平台产物位于 `electron/out/make/`。计划版本为 **0.1.0**；当前正式门槛未通过，尚未制作本轮平台包，实际状态如下。

| 步骤／产物 | 本轮结果 |
|---|---|
| `npm run verify` | 受正式门槛阻止，未执行 |
| `npm run make` | 受正式门槛阻止，未执行 |
| `npm run smoke:minecraft-package` | 受正式门槛阻止，未执行 |
| 发布包路径、大小、SHA-256 | 无本轮产物；均无可报告值 |
| git tag／GitHub Release | 均未执行 |

**本轮文档通过独立 release 分支与待审查 PR 审阅；未创建 tag 或 GitHub Release。** 正式场景失败按任务要求阻止 `verify`、`make` 与包冒烟；本轮没有发行包或产物 SHA-256。后续修复与重新验证需要单独记录，不得用旧冻结或实验场景结果补足本轮失败。

本地打包与 runtime 冒烟只证明相应检查的结果，不代表新 core 已接入 Electron GUI，也不证明 Developer ID 签名、公证、Windows/Linux、正版认证或真实 Provider 端到端验收。tag 和 GitHub Release 需另行确认后执行。

源码归档不包含 `node_modules`、JDK、服务端 JAR、世界/存档、完整原始日志、账号缓存、学习记忆、个人配置、环境文件、凭据或未获授权的 Live2D/Cubism 资产。第三方 bundle 的许可与 notice 状态须另行核查；当前包审计检查受限素材，不覆盖许可证完整性。
