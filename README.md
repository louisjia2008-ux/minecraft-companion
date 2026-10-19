# Minecraft Companion

**许可证：GNU AGPL v3，仅限第 3 版（`AGPL-3.0-only`）。** 本项目自有代码采用强 copyleft；分发或通过网络提供修改版服务时的源码义务见 [LICENSING.md](LICENSING.md) 和 [LICENSE](LICENSE)。

Minecraft Java 陪玩代理的独立源码快照，供后续梳理、重构与规划使用。导出日期：2026-10-19。

**当前状态：开发中。没有完成“新种子、空背包、同一个正式任务代理，装备、房子、原生家具使用、受伤反击、战后清障和恢复任务全部通过”的整套自动验收。** 仓库保存当前实现和测试，不代表已交付可稳定完成生存建造的产品。具体状态见 [STATUS.md](STATUS.md)。

## 内容

- `electron/minecraft-runtime/`：Mineflayer 运行时、正式任务代理、任务规划与执行、寻路、战斗、采集、制作、建造、家具交互，以及回归测试和脱离世界文件的地形夹具。
- `electron/src/main/minecraft/`：Electron 主进程服务、运行时生命周期、事件与 Provider 桥接。
- `electron/src/shared/minecraft*`、`electron/src/preload/`：类型、协议与受限 IPC。
- `electron/src/renderer/console/MinecraftPage*`：陪玩控制面板。
- `electron/scripts/`、`electron/tests/`：本地服务器安装工具、打包与宿主集成检查。
- `acceptance/`：真实本地服务器验收脚本，包含新种子入口及保存世界开发续跑入口。旧版本脚本保留作开发参考。
- [ARCHITECTURE.md](ARCHITECTURE.md)：主要入口与控制链，便于规划重构范围。
- `SOURCE_SNAPSHOT.json`：原始复制文件的 SHA-256、导出后的 SHA-256，以及可移植性调整说明。原始 Git HEAD 仅标识基线；本快照也包含此前未提交的源码改动。

Electron 的其余源码用于保留界面、配置、安全 Provider 与窗口管理依赖，避免只上传一个无法接回宿主的 Minecraft 页面。未打包其他原生桌宠项目。

## 安装与离线检查

要求 Node.js >=22、npm >=10。完整桌面端依赖按其锁文件安装：

```sh
cd electron
npm ci
npm run typecheck
npm test
npm run test:security
```

只研究 Minecraft 任务引擎可独立安装：

```sh
cd electron/minecraft-runtime
npm ci --ignore-scripts
npm test
```

`npm test` 是离线回归，包含模拟服务器回包与真实 Mineflayer 寻路/物理组件检查；它不能证明真实游戏全流程通过。当前快照可能存在已知失败，见状态文档；上传不以修改测试或隐藏失败为前提。

运行 JSONL 桥接协议：

```sh
cd electron/minecraft-runtime
npm start
```

协议与请求示例见该目录的 [README](electron/minecraft-runtime/README.md)。启动运行时不会自动连接服务器或恢复 58 号世界。

## 桌面端与真实服务器

在 `electron/` 安装依赖后可执行 `npm start`。macOS 的迁移辅助程序构建需要 Swift；其他平台按现有脚本跳过该辅助程序。模型资源需自行通过应用的既有导入流程配置，仓库不携带 Live2D/Cubism 资源。

本地 Java 服务器安装流程见 [MINECRAFT_LOCAL_SERVER.md](electron/docs/MINECRAFT_LOCAL_SERVER.md)。安装工具会从官方来源下载 JDK/服务器；实际运行需要用户自行接受 Minecraft EULA。代码上传没有启动、恢复或重跑游戏。

当前新种子正式入口：

```sh
node acceptance/natural-public-building-acceptance-v13-camp-respawn.cjs --help
```

58 号世界开发续跑入口为 `acceptance/saved-world58-development-continuation-v1.cjs`。它需要本地已有保存世界及其配套安装/任务状态；本仓库不包含这些数据，不能将续跑当成新种子验收。所有真实验收均需明确安排后手动启动。

## 导出范围与权限

包含当前工作代码、锁文件、测试、源码夹具和验收工具。未复制原仓库 Git 历史、游戏世界、存档、完整原生事件日志、任务检查点、学习记忆、聊天历史、账号缓存、API 凭据、已安装依赖、JDK、服务器 JAR 或构建产物。

独立副本中的验收入口已使用仓库相对路径；部分旧源码文档保留其历史语境，最新范围与验收状态以本 README 和 STATUS.md 为准。

项目自有源码与第三方组件的权利范围见 [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和运行时的 [PROVENANCE.json](electron/minecraft-runtime/PROVENANCE.json)。迁入的 `vendor` 源码保留原来的来源/授权说明；此导出不额外授予第三方模型或 SDK 的再分发权限。

`tools/local-validation/` 保留先前的离线审计、有限地形导出、诊断与历史验证工具；`tools/legacy-controlled/` 和 `acceptance/historical-drafts/` 保留旧实验代码。部分旧工具使用独立客户端或受控资源，因此不满足当前“同一正式任务代理”的验收标准，也不是后续正式验收的推荐入口。它们需要匹配的本地数据，不能在新克隆中直接充当成功证据。
