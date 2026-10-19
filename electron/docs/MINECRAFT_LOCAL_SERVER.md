# 本地 Minecraft 真实服务端验收

这些开发工具为 Minecraft 陪玩建立独立的本机测试环境。它们不读取已有 Minecraft 存档，不需要 Microsoft 登录，也不调用云端 AI。服务端只绑定 `127.0.0.1`；离线认证仅用于这台隔离测试服。

## 安装 Java 与官方服务端

在 `electron` 目录运行：

```sh
npm run setup:minecraft:local
```

安装脚本从 Adoptium 官方元数据选择 Java 21，从 Mojang 官方版本清单下载 Minecraft Java Edition 1.21.8。JDK 使用 SHA-256 校验，版本元数据和服务端使用 Mojang 发布的 SHA-1 校验。文件默认放在仓库旁的 `.minecraft-local-test`，不会加入 Electron 分发包，不修改系统 Java 或 shell 配置。macOS/Linux 的 arm64、x64 可使用此安装工具；Windows 自动安装暂未实现。

已有完整缓存时，可以重新校验并离线复用：

```sh
npm run setup:minecraft:local -- --offline
```

也可通过 `--root /absolute/test-directory` 指定目录；运行真实验收时对应传入 `--installation /absolute/test-directory`。

## 随机种子的正常生存验收

```sh
npm run test:minecraft:natural -- --accept-eula --run-name natural-check-01 --diamond-count 16 --timeout-ms 7200000
```

第一次运行在 Java 生成世界前抽取一次随机 64 位种子，并把精确十进制值保存在 `.minecraft-local-test/natural-diamond-campaign.json`。后续修复轮次在新目录中沿用这一个种子，拒绝覆盖旧世界；不要删除或替换该清单来挑选地形。正常世界保留原生结构、自然出生点、Normal 难度、生存模式、昼夜、天气、生物生成、自然回血与死亡掉落。

该验收不提前放置树、食物、铁、钻石或岩浆，也不执行发物品、瞬移、时间、天气、效果或游戏规则修改命令。它只提交生产指令“从零开始挖到钻石”，或对应 `--diamond-count` 的实际采集数量（1–64，默认 1）；上例请求 16 个钻石，并逐阶段核对公共计划和远征目标确实为 16。观察实际采集、工具制作、下矿、口粮、矿石和返程。任务执行期间控制台命令数必须为零；任务前后可只读查询种子、规则、库存、位置及矿格。服务器时间中的 BigInt 以精确十进制字符串记入 JSON 证据。

原自然验收脚本的 `acceptancePassed` 同时要求钻石真实入包并返回营地、自动下降、完整工具链、服务端库存/位置/矿格一致，以及**实际吃食物后饥饿值上升**和**遇到真实岩浆后改路继续推进**。只备好口粮、只看见岩浆或未触发这些场景，均不能算对应验收通过。日志保存生命、饥饿、自然资源感知和真实动作，便于区分生产故障、脚本故障与未观察的覆盖项。自然矿道可能在浅处提前遇到钻石；此时任务可以 completed，而没有触发进食或岩浆的验收项仍为 false，进程因此返回 1。选择更长的实际采矿目标可覆盖更深流程，不允许为触发条件注入饥饿或安排无意义行走。

## 实际倒桶岩浆与带家具住宅专项

按用户最新要求，自然采集与岩浆覆盖分别验收，不继续长跑等待天然岩浆。原自然轮次严格结果保留。倒桶专项由另一个真实客户端使用 lava_bucket，在任务提交前确认实际源格；生产任务期间禁止控制台干预：

```sh
npm run test:minecraft:lava -- --accept-eula --run-name bucket-check-01
```

家具施工分别运行两档公开中文任务，测试材料预先提供，机器人在真实生存模式移动、放置和交互：

```sh
npm run test:minecraft:house -- --accept-eula --profile cottage --run-name house-cottage-check-01
npm run test:minecraft:house -- --accept-eula --profile enchanting_library --run-name house-library-check-01
```

普通住宅包含床、工作台、箱子、熔炉、玻璃窗、照明、门廊及坡屋顶；高级住宅再增加附魔台和15个有效书架。施工期间控制台命令必须为零。施工结果冻结后，家具使用专项可以受控提供合成/冶炼材料、设置夜间及附魔经验，分别记录实际合成、箱子存取、冶炼、睡眠和30级附魔。正常停服后独立读取 MCA/NBT 并从实际保存方块生成可视图；图纸预览不作为建成证据。该专项不证明从零取得羊毛、皮革、甘蔗或黑曜石。

## 受控地形的完整任务回归

阅读并接受 [Minecraft EULA](https://aka.ms/MinecraftEULA) 后运行：

```sh
npm run test:minecraft:live -- --accept-eula
```

每次运行创建新目录，拒绝覆盖已有测试世界。服务端启动后打印实际本机端口和存档目录。机器人以空背包、生存模式执行公共指令“从零开始挖到钻石”，任务结束或受阻后保存证据并正常停止服务端。可以用 `--run-name diamond-check-01` 指定简单目录名。

验收使用官方 vanilla 服务端及真实 Mineflayer 客户端。移动、重力、挖掘、合成、熔炼、工具耐久、掉落和饥饿均由实际游戏执行。测试开始前一次性布置静态地形：地表 Y=30 的原木与成熟作物、完整石层和深板岩层、铁矿、岩浆屏障及埋藏钻石。任务开始后控制台只读取状态，不放置矿物或发放工具/钻石。

这是可重复的受控地形验收。它用于验证完整工具链、阶梯下矿、深层探矿、岩浆绕行、钻石入包与返程；不代表所有随机种子、服务器插件、敌对生物场景或 Minecraft 版本都已通过。

## 查看证据与保留测试服

每轮目录位于 `.minecraft-local-test/worlds/<run-name>`：

- `server.properties`：实际监听地址、端口及世界配置。
- `server.log`：官方服务端完整日志。
- `events.jsonl`：布置命令、任务阶段、实际位置/库存、方块变化及诊断。
- `server-readback.log`：服务端独立读取的库存、位置、生命、饥饿、矿块与岩浆状态。
- `result.json`：完成状态和验收条件；`acceptancePassed` 必须为 `true`。
- `world/`：实际挖出的矿道与方块变化，保留供检查。

如需手动检查某轮存档，确认该轮服务端已正常停止，再从 `electron` 目录执行。以下例子打开本次通过的存档：

```sh
source ../../.minecraft-local-test/environment.sh
cd ../../.minecraft-local-test/worlds/natural-diamond-11
java -Xms1G -Xmx2G -jar ../../server.jar nogui
```

`source` 只影响当前终端；新开终端需再次执行，或直接使用 `installation.json` 里的 Java 绝对路径。系统默认 `java` 没有被替换。

连接地址与端口以该轮 `server.properties` 为准。输入服务端命令 `stop` 正常保存并停止。再次验收请创建新的轮次，避免将已有物品与矿道当成从零起步的证据。

## 2026-10-12 本机实际结果

macOS arm64 上安装并执行的是 Temurin `21.0.12.1+1-LTS`、官方 Minecraft Java `1.21.8`。JDK 压缩包 SHA-256 为 `3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998`，服务端 SHA-1 为 `6bce4ef400e4efaa63a13d5e6f6b500be969ef81`；再次离线校验和实际 `java -version` 均通过。其他安装平台属于工具实现范围，未据此宣称实机验证。

`real-diamond-05/result.json` 的 `acceptancePassed=true`：从空背包开始，完成木镐、石镐、采铁冶炼、铁镐、阶梯下到 Y=-53、岩浆绕行、左右分支探矿，采到 2 个钻石并回基地。整轮约 14 分 40 秒，服务端独立读取确认全部库存/位置一致，生命与饥饿为 20。服务端和独立打包冒烟服均已正常保存停止，存档与日志保留。

自然第11轮已经从空背包采集33钻石并返回出发点，工具补充、自然口粮和真实进食通过；原严格岩浆覆盖保持未触发。独立 `bucket-lava-02` 实际倒桶测试完成危险拒绝、改道、钻石入包及返程，16/16项独立审计通过。重启任一存档后，连接实际端口请读取该轮 server.properties，版本 `1.21.8`、离线认证。`DeskPetMiner` 为钻石验收玩家名，`DeskPetHouse` 为家具住宅玩家名；重新从零验收应使用上面的 `test:minecraft:live` 创建新世界。完整证据与早期失败见 [真实服验证记录](MINECRAFT_REAL_VALIDATION.md)。
