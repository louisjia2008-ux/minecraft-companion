# Minecraft Companion

面向 Minecraft Java Edition 的陪玩代理源码，包含一个独立开发中的决策 core、真实 vanilla 服务端场景工具，以及保留的 Electron 桌面宿主与旧任务引擎。

**v0.1.0-alpha.1 源码开发预览。** 已完成 **24场景32/32轮** 正式游戏验收；各冻结版本的完整离线检查与后续失败分别记录，最终发行版本的完整重验结果见随包 `RELEASE_ATTESTATION.json`。新 core 尚未接入 Electron 的命令与生命周期，现有 CLI 用于开发和场景验证，没有独立的普通玩家自由游玩启动入口。当前范围与已知局限见 [STATUS.md](STATUS.md)；完整命令、结果与修复记录见 [VALIDATION.md](VALIDATION.md) 和 [正式脱敏验证摘要](docs/validation/2026-10-24/VALIDATION_SUMMARY.md)。

项目自有源码采用 **AGPL-3.0-only**。许可证、继承来源和第三方声明分别见 [LICENSE](LICENSE)、[LICENSING.md](LICENSING.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 可以研究什么

`electron/minecraft-runtime/core/` 通过一个决策循环协调生存反应、补给、恢复和当前目标。目标包括采木、从空背包建家并取得铁装备、耕种、畜牧、材料采集、深层采矿、下界石英，以及刷石机、自动熔炉和其他装置。它们的当前实现和对应场景不等于任意自然种子上的可靠性保证。

自主模式默认关闭。打开后，默认目标卡仅包含 **家园、食物储备、漏斗刷石机、自动熔炉**。种田、畜牧、下界、捕鱼、甘蔗/刷怪/铁农场和地毯/铁轨装置由独立的显式 API 或相应场景调用；它们没有全部加入默认自主调度。

源码中的 `core/companion.js` 提供 `createCompanion({ bot, onEvent, autonomy })`，接收由调用方连接并准备好的 Mineflayer bot。它是开发者 API，涉及连接、取消、关停和世界生命周期；现成的复现入口是下面的场景 CLI。代码导航见 [ARCHITECTURE.md](ARCHITECTURE.md)，各目标说明见 [core/README.md](electron/minecraft-runtime/core/README.md)。其中较早版本的测试数字属于历史记录，当前冻结版本以 [VALIDATION.md](VALIDATION.md) 为准。

## 嵌入其他项目

嵌入 DeskPet、LLM 工具调用或其他宿主时，可显式使用 `index.js --engine core --data-dir <独立绝对目录>`，或调用 `createCoreHost` 使用相同的结构化工具协议。新适配层提供任务 ID、真实终态、有限防重、显式替换、保留生存保护的暂停/取消和显式重连；默认旧 JSONL / Electron 链路不变。合同、示例和回归命令见 [嵌入接口](docs/EMBEDDING.md)。

## 安装源码与离线检查

已验证 Node.js **22.22.0** 与 npm **10.9.4**。历史离线冻结 `1f3d03f` 的原样完整 runtime full13：**3338/3338 PASS，自然 exit0，0 fail/cancel/skip/todo**；七项原命令：**全部自然 exit0：runtime3338/3338、host74/74、security6/6、legacy25/25、setup18/18，lint/typecheck通过；874文件源码前后不变**。正式游戏验收与离线冻结分别记录在 [VALIDATION.md](VALIDATION.md)，最终发行源码、干净安装、隐私审计及 PR/main CI 结果由发行附件 `RELEASE_ATTESTATION.json` 绑定。其他 Node/npm 版本尚未验证。下载对应预发布的源码归档或检出对应标签后，在仓库根目录运行：

```sh
npm ci --ignore-scripts --prefix electron
npm ci --ignore-scripts --prefix electron/minecraft-runtime
npm run lint --prefix electron
npm run typecheck --prefix electron
npm test --prefix electron
npm run test:security --prefix electron
npm run test:minecraft:acceptance --prefix electron
npm run test:minecraft:setup --prefix electron
npm test --prefix electron/minecraft-runtime
```

这里分别检查宿主、security、legacy acceptance、安装器专项测试和原样完整 runtime。`npm run test:core --prefix electron/minecraft-runtime` 可单独检查新 core 子集；它不能代替完整 runtime `npm test`。这些命令包含离线夹具与建模的服务端回包，不能代替真实 Java 服务端验收。资源记忆的原生运动测试还验证实际到达、地面支撑、朝资源的距离改善和未访问路点零信用；有限探测可选择其他改善方向，不要求固定沿某一坐标轴行进。此前固定坐标断言的两次完整失败保留在验证报告。树冠脱困正例使用只有原点叶柱的树冠并要求真实四格下降；UNKNOWN对照则禁止虚构下树信用。紧急跨水夹具还等待初生身体经真实Physics连续落稳，未落稳时必须拒绝移动；原低血量与回营要求保持。旧干路前缀的离线夹具则在明确加载的干燥条带中确认旧节点重接和真实新访问，UNKNOWN不能制造新节点信用；原时限与真实运动要求保持。`--ignore-scripts` 只跳过安装阶段的生命周期脚本。迁移单测对 Electron 文件选择对话框使用本文件内的替身，并禁止任何调用；其余迁移、文件系统、仓库与安全存储逻辑仍真实运行。因此这些单测不要求下载或启动 Electron 二进制。此前候选的延迟下载与最终一次下载失败均保留在验证报告；这项隔离修复和最终完整检查由发行验收单绑定。宿主单测不代表桌面 GUI/provider 验收。开发桌面 UI 时另在 `electron/` 正常 `npm ci`，其 postinstall 会安装 runtime。依赖由接收者按锁文件安装，源码归档不携带 `node_modules`。

## 第一个真实服务器场景

本地服务端工具固定使用 Java 21 和 vanilla 1.21.8。macOS/Linux 的 arm64、x64 可使用现有安装工具；其他宿主需要自行准备兼容运行环境。安装工具从 Adoptium/Mojang 官方元数据下载并验证文件，默认写入仓库根的 `.minecraft-local-test/`，不替换系统 Java。

每次下载的响应头等待和无有效数据进展各限 5 分钟，总下载限 15 分钟；安装器不自动重试，仍需通过官方大小与校验和验证。旧候选 0898 两次达到原 300 秒总期限的失败和修复边界见 [VALIDATION.md](VALIDATION.md)。安装器代码冻结 `8f324745527b7b13e6553b57c11af3309ebd9871` 已通过完整 runtime **3327/3327** 和安装器专项 **18/18**；最终发行文档提交、干净检出、归档安装及 CI 的实际结果由发行附件 `RELEASE_ATTESTATION.json` 绑定。游戏动作和正式场景预算保持不变。

从仓库根目录运行安装工具：

```sh
node electron/scripts/setup-minecraft-local.mjs
```

阅读并接受 [Minecraft EULA](https://aka.ms/MinecraftEULA) 后，运行一个采木场景：

```sh
cd electron/minecraft-runtime
mc_validation_batch="local-logs-$(date -u +%Y%m%dT%H%M%S)-$$"
npm run scenario -- --accept-eula --scenario collect-logs-flat --runs 1 --seed 101 --batch "$mc_validation_batch"
```

场景会启动仅绑定 `127.0.0.1` 的隔离离线测试服、设置受控条件、运行原生 Mineflayer 动作、查询服务端结果，然后保存停服。每个新 batch/scenario 目录建立一个新世界；同一场景的重复轮次默认在该世界中重新 setup 并复用 bot。`--seed` 控制 setup 的布局随机数，世界生成种子由场景本身定义。已有 batch/world/result 会被拒绝覆盖；重新验证请换一个 batch 名称。

直接场景 CLI 收到 SIGINT/SIGTERM 会停止当前与后续轮，保留 `pass=false` 的中断 result，再通过 console 停服并确认保存/关闭；首次信号确定 exit 130/143。父调度器的停止还需转发给所属子 CLI，不能假定只停止父进程就已清理服务器。各轮保存收据与中断历史保留在验证报告中。

查看全部场景或参数：

```sh
node tools/run-scenarios.cjs --help
```

此帮助命令按现有 usage 合同输出完整参数与场景列表，并返回退出码 **2**；它不启动服务器，也不是一次验收失败。真正运行场景仍须自然退出 **0** 并取得通过的原始结果。

## 完整场景套件

full 包含 **24 个场景、32 轮**，保留采木、夜间、耕种与畜牧的重复次数。所有 full 场景均要求每轮通过；任何超时、最终任务失败、读回/清理错误或服务端条件不足都会保留失败并使进程非零退出。

```sh
npm run regression -- --accept-eula --suite full --seed 101 --parallel 2
```

这个命令使用统一的 setup base seed 101。本轮正式验证对 E2E 单独使用 seed 1，其余场景使用 101；准确参数、重复轮次、准备条件及实际逐轮结果表见 [VALIDATION.md](VALIDATION.md)。套件定义在 [scenarios/regression.cjs](electron/minecraft-runtime/scenarios/regression.cjs)。不要用 `--runs 1` 覆盖 full 的重复次数后仍称为 32 轮验证。

full 含 150 分钟的自然家园场景和 300 分钟的 E2E 上限，需为多个 Java 进程预留内存、CPU、磁盘与时间。`--parallel` 控制同时运行的场景数，默认 2；每个服务器默认最大堆 2 GB。较短的 quick 套件可以用于开发反馈，但不覆盖完整 full。

单独运行原 E2E：

```sh
npm run e2e -- --accept-eula --sessions 1 --seed 1
```

E2E 从空背包开始，在受控平地完成家园后由默认自主目标收集材料并建两台机器，保留两次死亡、背包塞满和掉坑四类故障。最终必须同时满足房屋与装备、家具使用、刷石机和熔炉产出、四项恢复及存活；早期 `goal_done` 或“还活着”不能替代终态验收。

默认结果目录是 `.minecraft-local-test/scenario-runs/<batch>/<scenario>/`。`summary.json` 保存逐轮结果和统计，`run-NN.jsonl` 保存原始事件；总套件另有 `regression.json` 或 `e2e.json`。长跑中的 heartbeat 和 steps 只用于诊断，完整结果必须等最终 `result` 与 summary。

## Electron 与旧运行时

桌面链仍为 `MinecraftPage → IPC → MinecraftService → JSONL bridge/runtime → vendor/server/minecraftTaskAgent.js`。把 `core/` 源文件复制进包不会自动接通新 core；桌面端的暂停、恢复、取消、重连、状态转换和真实 UI 操作仍需另行完成新 core 集成验收。

开发现有宿主可在 `electron/` 安装依赖，并运行 `npm run typecheck`、`npm test`、`npm run test:security` 与 `npm start`。在 `electron/minecraft-runtime/` 执行 `npm start -- --data-dir <独立绝对目录>` 启动的是旧 JSONL helper，需要独立的绝对 `--data-dir`，协议见 [runtime/README.md](electron/minecraft-runtime/README.md)。它不是新 core 的自由游玩入口，也不会自动连接服务器。

本版仅提供源码归档，不提供桌面安装包。macOS shell 构建/冒烟不证明新 core 已接入，也不代表 Developer ID 签名、公证、Windows/Linux、正版认证或真实 Provider 端到端验收。第三方 bundle 的许可变体和 notice 覆盖尚有待关闭，因此不分发该 bundle 的依赖字节。

## 源码归档范围

源码归档范围包含项目源码、锁文件、构建配置、测试、必要的有限源码夹具、许可证和来源声明，以及最终脱敏验证摘要。项目级构建配置属于源码；本机安装配置和个人运行状态不包含在内。

不包含依赖安装目录、JDK、Minecraft 服务端 JAR、游戏世界/存档、完整原生日志、账号或授权缓存、学习记忆、个人配置、环境文件、API 凭据、Live2D/Cubism 资产或桌面构建产物。`acceptance/`、`tools/local-validation/` 等保留的旧入口有各自的引擎、条件和本地数据依赖，不能拿其局部结果补足新 core 的正式 full。

正式24场景32/32轮已通过；保留的失败、中断历史、源码身份和已观察局限见 [VALIDATION.md](VALIDATION.md)。E2E 中旧矿道前沿返程约11分37秒重试，随后自主弃矿、重新采到煤并完成任务；仍有站位验证与恢复效率的改进空间。本次结果不等于所有自然种子或长时自由游玩可靠性保证。

版本为 **v0.1.0-alpha.1**，仅源码开发预览。游戏测试 commit 与后续包含文档、CI、离线夹具和安装器修正的发行 commit 应分别记录；最终资产清单与 SHA256SUMS 在发行时绑定实际归档。
