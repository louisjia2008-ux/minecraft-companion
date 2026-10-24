# 当前状态 — v0.1.0-alpha.1 源码开发预览

**正式游戏验收通过，离线检查按冻结快照记录。** 测试冻结 `a22a73a4a7294ab5409b6e74ee882b2603ab528b`，867 文件 sourceHash `2b47b336ab2279cc27e12ebebf418e508e557e5b09ce4b35a91f97690bf3e73f`。原样完整 runtime full7 自然通过 3326/3326；正式 full03 于 2026-10-24 02:15:09.845—03:27:27.151 UTC 自然完成，24 场景、32/32 轮全部通过，原始结果、退出码与源码/driver 一致。 源码归档、干净安装与发布验证的最终收据随 release 单独提供，和本页的游戏验收快照分别绑定。[正式脱敏验证摘要](docs/validation/2026-10-24/VALIDATION_SUMMARY.md)。

首次 [云端 CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40060016518) 在候选 07bd 上记录 runtime3325/3326、1fail，原失败保留。后续仅修正池塘食物路线离线夹具，使配置与正式 `survival_food` 一致，并增加 UNKNOWN 不得授予移动的负例；没有修改生产代码、正式 harness、锁文件或预算。最终发行提交的全量离线、PR/main CI 与归档消费结果由 release 中的独立验收单分别绑定，不能把 a22 full03 说成后续 SHA 的重新游戏长跑。

## 安装器代码与发行验证

安装器代码冻结提交（`INSTALLER_CODE_FREEZE`）：`8f324745527b7b13e6553b57c11af3309ebd9871`；最终发行文档提交由外部验收单记录。原样完整 runtime full9：**3327/3327 PASS**，自然退出0，fail/cancel/skip/todo均为0。最终发行文档提交、CI与消费者结果由发行附件绑定。此前00783/full8自然3327/3327和0898全新源码消费者3327/3327（host74/security6/legacy25及lint/typecheck通过）是各自快照结果。0898的 [PR CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40063704497) 状态记为 `历史0898 CI PASS3327/3327（05:07:09 UTC完成）`；它不充当下一冻结的发布门禁。

0898的归档消费者02/03各自使用全新空目录，在官方JDK下载阶段分别经过301.5748秒、301.3471秒自然exit1，原300秒总期限未改；两次均没有完成Java/Minecraft安装、离线复查或采木游戏。安装器改为header300秒、流idle300秒、固定total900秒，不自动重试；runtime core/vendor、正式场景/harness和游戏期限分别保持。安装器专项原命令已加入CI，并在该代码冻结自然通过18/18（14个顶层、4个子用例）；full9宿主74/74已自然通过，同冻结的lint/typecheck、security6/6、legacy25/25也已自然通过；完整runtime3327/3327也已自然通过；后续新消费者和CI由各自实际收据记录。两次失败及新验证须分别保留。

## 执行与分发范围

新 `core/` 由单一决策循环协调目标、生存与维护；自主模式默认关闭，默认四类卡片为家园、储粮、漏斗刷石机和自动熔炉。其他目标由显式 API/专项场景调用。新 core 尚未接入 Electron；桌面仍走 vendor 旧代理和 JSONL 链。本版仅源码开发预览，不分发桌面安装包或第三方依赖 bundle。已验证 Node22.22.0/npm10.9.4，其他较新版未验证。

## 已取得证据

| 层次 | 已观察结果 | 边界 |
|---|---|---|
| 原样完整 runtime full7 | **3326/3326 PASS，自然exit0；0fail/cancel/skip/todo；sourceChanges[]** | 离线完整脚本 |
| 当前a22宿主检查 | host74/74、security6/6、legacy acceptance25/25、lint/typecheck通过 | 保留一次70/74、4个本机listen EPERM环境失败；有监听权限后原样74/74；非GUI/provider证明 |
| 正式 full03 | **24场景32/32轮PASS，自然exit0** | 原合同/时限/重复次数；24隔离world、场景内reuse+reset，非任意种子保证 |
| E2E完整流程 | **71分9.204秒；最终home95/95、铁剑/铁镐/盾各1、generator收集8、smelter熔炼5/收集4；四fault恢复、HP20存活、2计划死亡/0额外死亡** | 受控资源平地；钩子恢复标记不等于掉落物回收全耗时 |
| 新 core Electron集成、GUI/provider | 未完成/未观察 | 源码及游戏CLI不代替桌面产品验收 |
| 发行资产与干净提取安装 | 待最终发行收据 | 发行commit与测试冻结分别绑定 |

## 已知局限与历史

旧引擎与暂停世界的历史状态保留在 [2026-10-19 旧状态](docs/history/2026-10-19-legacy-status.md)。本页新 core 验收与该历史执行链分别记录。

E2E补煤途中旧前沿返程发生约11分37秒返矿/双计数脱困，原程序随后自主弃矿、新矿实际取得coal1，最终合同通过。这是已观察的恢复成本；站位验证与恢复计数协调仍可改进，不声称全功能无已知问题。首个计划死亡的实际掉落回收曾先超时240秒，第二次尝试后恢复；20秒注入钩子标记不能代表整个回收过程。

完整失败/中断历史见 [VALIDATION.md](VALIDATION.md)：full6自然3324/3325失败保留，a22仅校正测试逻辑时钟且生产/5000ms/真实8s门槛不变；full01六个中断保存仍UNCONFIRMED；full02保留30轮通过/2轮中断及两世界保存确认。当前结果来自一批完整冻结运行，未拼接历史通过。

第三方bundle的vec3许可变体/notice门槛未闭，因此不分发依赖字节；接收者按锁文件自行安装。源码许可与来源声明随源码保留。
