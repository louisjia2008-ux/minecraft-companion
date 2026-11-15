# 当前状态 — 2026-11-06 发布阻断

> **2026-11-06 05:10 CST 开发状态：候选13限定恢复修复已完成定向及独立审查，尚未完整离线或游戏验收。** 仅原桥面返程准入、目标恢复状态与全会话死亡owner三处生产修改；461相关/独立54项通过，原桥梁Native与护栏36函数保持原样，查询不修改实际支撑记忆，不扩物资/预算/时间。最新完整八项仍仅属于下方候选12；13须独立冻结、锁定依赖及全八项后再真实验证。当前发布阻断。

> **2026-11-06 04:20 CST 当前：候选12完整八项通过，真实游戏仍发布阻断。** 未提交 tree `75b64d5c4efe7d807fda44a8615cdb46008e8c4e` / sourceHash `0fd1a2a283a44995dc468a98a9ab1b3a51b1f7793470763997ecf6de4a8d0b5b`，952文件不变。依赖就绪后的完整原八项：runtime4029/4029、core1021/1021、host74/security6/acceptance25/setup18、lint/typecheck通过，0fail/cancel/skip/todo。首轮归档未准备依赖的完整FAIL与两项10s超时取消另留原日志，不以重验覆盖。12人工岸阶段已自然FAIL300432ms，真实2石英/0死，未完成8矿；原正式石英、独立E2E三组与当前受控死亡仍运行；完整full35/43、自然1/2各16h、原city101与当前受控死亡/宿主等仍须独立验收。11的E2E3PASS只属11；11full为13PASS+2显式中断+28未执行，natural1为3死后保存中断，均非整套通过。11死亡补给安全再入和实战防御子门通过，但0石英/off_confirmed_route整体FAIL。详见[本轮记录](docs/validation/2026-11-05/HANDOFF.md)。

以下带时间的更新与冻结结果均为历史检查点，不替代上述当前身份。

> **2026-11-06 01:22 CST 当前：候选09完整八项通过，仍发布阻断。** runtime3942/3942、core934/934、其它六项通过，947源码SHA未变。09正式石英/E2E3/人工岸边运行中；full35/43及09自然1/2等必要实服验收尚无完整结果。07自然旧轮因源码更新保存中断（5/12死，非PASS），08全量失败保留。

> **2026-11-06 00:41 CST 更新：候选08完整八项整体FAIL。** 六项通过；runtime3933/3934与core925/926各同一cached项目cancel后resume失败，0取消、947源码SHA不变。09窄修复中；无08游戏通过。07自然种子1/2仍运行，第104分钟分别2/5死；不能替代当前整套验收。详见[本轮记录](docs/validation/2026-11-05/HANDOFF.md)。

> **2026-11-05：当前候选发布阻断。** 本页下方验收数字均保留原冻结身份，不代表 main `d53883b`、#31 `2eb307c` 或本轮整合代码。原石英、末地及 e2e 失败不能被不同种子或旧版本通过抵消；本轮检查和未完成门槛见 [HANDOFF](docs/validation/2026-11-05/HANDOFF.md)。

## 历史冻结：v0.1.0-alpha.1

**以下为历史正式游戏验收，离线检查按各自冻结快照记录。** 测试冻结 `a22a73a4a7294ab5409b6e74ee882b2603ab528b`，867 文件 sourceHash `2b47b336ab2279cc27e12ebebf418e508e557e5b09ce4b35a91f97690bf3e73f`。原样完整 runtime full7 自然通过 3326/3326；正式 full03 于 2026-10-24 02:15:09.845—03:27:27.151 UTC 自然完成，24 场景、32/32 轮全部通过，原始结果、退出码与源码/driver 一致。 源码归档、干净安装与发布验证的最终收据随 release 单独提供，和本页的游戏验收快照分别绑定。[正式脱敏验证摘要](docs/validation/2026-10-24/VALIDATION_SUMMARY.md)。

## 主分支旧干路前缀用例的后续移动超时

主分支58d451的CI40087560335自然记录3341/3342、唯一旧干路前缀用例(0)的`dry_graph_leg_timeout`，4197.32517ms。原日志没有失败腿目标或身体/probe遥测，精确首因仍UNKNOWN；用例先reconcile旧前缀再拓展新路点，不能仅凭名称把超时归为rejoin移动。原始失败继续保留，后续修复与重新验收分别绑定。

同一58d451的full17本地3342/3342、干净检出全套、归档实际采木11/10与正常保存、源码隐私审计及PR400860的3342/3342均曾独立通过；它们属于各自真实运行，不能覆盖新的main失败，也不替代下一最终发行源码的全部门槛。

本轮离线夹具修复把这个前缀合同限定到显式加载的干燥条带，保留anchor0、原记录节点16和offset0/-3，只允许一个未访问的新frontier(-16,1,0)。原前缀重接/failed-edge/访问数全部断言保留；纯观察reconcile不增加visit，随后必须真实原生运动到新节点、ground/support确认后才可增加一个访问。局部运动通过生产已有settleNativeGoto承接同一goal/profile与原绝对leg deadline，不增加goto、时限或移动信用。新的显式MODELED finite-UNKNOWN对照允许原前缀合法reconcile，但新frontier没有充分证据时不得产生motor、新节点或新visit。

透明原用例一次自然通过，随后一次真实原生切片控制也通过；它们未复现原CI超时，不构成原CI精确原因。原native 10ms Physics、4s leg、6s test及120s graph预算不变，生产执行文件未改。新最终完整检查、消费者与PR/main CI的实际结果由发行验收单另行绑定。

## 初生身体落稳的离线前提

原e632 CI400834自然记录3339/3340、唯一紧急跨水用例在初始化时报`dry_graph_not_on_surface`；失败时姿态未记录，CI精确首因仍UNKNOWN。透明原用例和独立首tick控制在本地均一次复现：初生vy0/onGroundtrue经第一次原Physics变为onGroundfalse，位置仍在支撑上；原ordinary调用先观察到的anchor保留visits1，失败本身没有移动信用。窄修复仅测试等待实际连续落稳后再做原低血量/双向跨水/回营验收，并新增全新graph在首tick未落稳时零移动/零访问拒绝；不设置速度或位置、不放宽生产守卫和原预算。

e8d1的原样完整full16已独立3341/3341通过，480235.79725ms，七命令均0；clean09全套通过，archive10实际采木11/10、44125ms、零死亡并正常保存。它们分别保留原身份，不能覆盖原CI400834失败，也不能代替最终full17及新消费者/CI门槛。

## 树冠夹具与复核观察边界

82eb的原CI400820自然记录3337/3338、唯一树冠用例失败（要求y1，实际y5），精确原首因因遥测缺失仍UNKNOWN。原半平面树冠容许在y5安全探索，并没有保证下一步下树。后续窄修复保留真实四格下降断言，正例树冠改为仅原点的一根叶柱；另保留明确UNKNOWN下原半平面安全路点零下降信用。资源回归观察器只补认生产既有100/500ms复核结果，不增加预算、重试或成功结果。

e632的完整full15七项原命令已自然通过：runtime3340/3340、host74、security6、legacy25、setup18和lint/typecheck，874源码前后不变。该通过属于其原冻结，不能覆盖82eb CI失败，也不代替最终full16/消费者/CI；最终身份与结果由发行验收单绑定。

## 资源记忆路点的合同修复

4c10的CI400809与82eb的本地full14分别自然记录3337/3338、同一资源记忆用例失败：断言要求`actual.z=0`，实际分别为-8、-12。失败时探测/姿态的完整遥测缺失，精确原首因仍UNKNOWN，不能由通过的干净克隆结果覆盖。生产图只在已通过原生探测的候选中按资源方向排序，并要求距离改善，没有固定轴向保证。本轮只修该离线测试：严格距离改善与实际到站/支撑取代固定轴向，并沿原期限使用既有生产settlement；新增UNKNOWN零信用和单次goto提前返回回归。三项定向一次自然3/3通过，仅属局部结果。完整重验及最终发行身份由发行验收单分别绑定，原游戏预算与执行代码保持不变。

## 宿主迁移单测的 Electron 隔离

4c10 候选的干净克隆完整 runtime 已自然通过3338/3338，但宿主测试仅69项通过：`native-migration.test.ts` 在注册五项测试前导入 `CharacterService` 的 Electron 对话框，触发依赖延迟下载并发生 `fetch failed`，该消费者整体失败，不能称为通过。最终修复只在该测试文件内提供禁止调用的对话框替身，保留真实迁移、文件系统与安全存储的全部五项断言；生产代码与游戏冻结不变。最终发行源码的完整重验、干净克隆、归档与CI结果分别由 `RELEASE_ATTESTATION.json` 绑定，下面full13仍是其原冻结的历史结果。

## 地表探测夹具冻结与full13历史结果

代码冻结 **`1f3d03ff3e9b2711ca75c8c4bc0c87d91a34bfe7`**，874文件，sourceHash `722e3143c519a0feaf14fc518814d103f8ebea8c32addf7d58e6653ca6876aad`。原样完整 runtime full13：**3338/3338 PASS，自然 exit0，0 fail/cancel/skip/todo**。同冻结七项原命令：**全部自然 exit0：runtime3338/3338、host74/74、security6/6、legacy25/25、setup18/18，lint/typecheck通过；874文件源码前后不变**。完整结果以该轮自然终态为准，旧full11或定向测试不能代替本轮完整结果。

本轮仅改地表图离线测试：让saved05读原生partial的预探测与生产一致使用`optimizePath:false`，保留真实非空partial的整数搜索节点检查；将池塘用例拆为明确模型的完整物理通行、第二次fresh UNKNOWN零未验证移动负例、以及“模型初始长UNKNOWN提示＋后续真实原生探测”的有限安全集成。后者仅以严格事实区分`NATIVE_RETURN_CONFIRMED`和`NATIVE_PROBE_UNKNOWN_SAFE_STOP`；安全拒绝不叫游戏流程通过。原12s/10s及100ms/500ms探测规则、Physics和正式游戏预算不变，原完整full12失败保留。新最终文档/消费者/隐私/PR与main CI分别绑定外置验收单。

## 历史矿道入口防御修复与full12失败

代码冻结 **`057f5ce1fb30263b93b7f62512837c14bfda12a4`**，874文件，sourceHash `0fc1d15a9dcaa8cbaf238487ed237c39debec2f4af9e163b3e3a140c232097d8`。原样完整 runtime full12：**3333/3335，2fail，自然exit1，0cancel/skip/todo**，耗时472577.846041ms。其余六项原命令同冻结自然通过：host74/74、security6/6、legacy25/25、setup18/18及lint/typecheck；sourceChanges[]。矿道入口防御修复用例已通过；新增失败为saved05斜坡规划夹具与池塘第二次fresh探测用例。新最终五文档提交及其消费者/隐私/PR与main CI结果仍由外置发行验收单分别绑定。

[PR20后续CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40075916022)在4f411上自然记录3334/3335、唯一矿道入口防御用例失败，精确失败时探测/姿态/探索图未记录，原首因仍UNKNOWN。独立受控对照只把正X方向有限原生探测降级UNKNOWN：旧单侧稳定地形实际走完8个其他方向节点后正确拒绝采矿；只改为营地四周均有稳定列后，同原生运动/防御/断言下取得材料并真实回营地。此机制反例不冒充原CI重放。窄修复仅该离线测试：防御用例不再暗含必须向东探索的假设，并增加同profile/两租约/原deadline及落稳采料断言；原30s/120s/8次/Physics、其他不对称和全沙用例保留。详情见[验证报告](VALIDATION.md)。

## 历史full11离线修复冻结

代码冻结 **`14b9ac5ee0dc413076414324476c6ef9756781fc`**，874文件，sourceHash `6a1c7b63189fb900d2c69e02990afa492ace25b941356ffc40508f65973a16d8`。原样完整 full11 **3335/3335 PASS，自然exit0，0fail/cancel/skip/todo**，耗时475088.889666ms；host74/74、security6/6、legacy25/25、setup18/18及lint/typecheck同冻结全部自然通过，sourceChanges[]且工作区干净。

[PR20首次CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40071530091)在39e6记录3325/3329、4fail，完整原日志与四窗口保留。新修复仅改三个离线测试文件：补齐长绕行的既有生产settlement适配、分别验证食物分支fresh成功与UNKNOWN零移动保护及真实调用方恢复、用实际不同生存租约和统一逻辑时钟验证最多两次恢复及原600ms期限。原CI没有记录实际中断序列或失败时elapsed，精确首因仍UNKNOWN；受控反例用于机制验证，不冒充原CI重放。原断言、动作预算与真实Physics保留，详情见[验证报告](VALIDATION.md)。

相对a22，core执行文件51份（显式排除已有发行文档core/README.md）、vendor168份、scenarios16份、tools6份和四份package/lock文件的路径、模式与Git blob一致；整个core目录因README文档不同而不称为逐字节相同。a22/full03的24场景32轮仍保留原运行身份。最终五文档提交、新消费者/归档、隐私与PR/main CI的门禁单独绑定发行附件，旧PASS不替代新门禁。

首次 [云端 CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40060016518) 在候选 07bd 上记录 runtime3325/3326、1fail，原失败保留。后续仅修正池塘食物路线离线夹具，使配置与正式 `survival_food` 一致，并增加 UNKNOWN 不得授予移动的负例；没有修改生产代码、正式 harness、锁文件或预算。最终发行提交的全量离线、PR/main CI 与归档消费结果由 release 中的独立验收单分别绑定，不能把 a22 full03 说成后续 SHA 的重新游戏长跑。

## 首次 main CI 失败与后续代码冻结

候选 `f588b8bdbc82c41e22d35f9a69802efa4c3487e5` 的 [PR CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40065977579) 通过后，[首次 main CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40067331000) 自然失败：完整 runtime3326/3327、1fail，0cancel/skip/todo。唯一失败为 formal14 原生上升 dirt-path 离线夹具，code `dry_graph_route_lost`。原日志没有失败时的 native error、path update 或身体姿态遥测，精确首因仍未知。独立受控45ms调度停顿证明，原生空partial可使goto在实际未到达时提前resolve；接入既有生产settlement后，同一受控停顿下等待1732ms、真实抵达原目标格并落稳、visits2。这是机制证据，不是原CI精确重放；PR通过不替代main门禁，原main失败不重跑或覆盖。

后续代码冻结：`264683ad461329a1f6b33849c97fb4b9bb400a84`；最窄修复范围：仅修正 formal14 离线夹具，接入既有生产 native-goto settlement，增加明确标记的初始 empty-partial 正例与取消负例。原样完整 full10：**3329/3329 PASS，自然exit0，0fail/cancel/skip/todo**，runtime总数 3329。同一264683/19fb冻结的七项原命令全部自然exit0：host74/74、security6/6、legacy25/25、setup18/18、lint/typecheck通过，源码前后无变化。最终文档提交、全新源码/归档消费者、隐私审计和新PR/main CI仍由各自真实收据与外置发行验收单绑定；a22 full03保留原24场景32轮身份。

## 安装器代码与发行验证

安装器代码冻结提交（`INSTALLER_CODE_FREEZE`）：`8f324745527b7b13e6553b57c11af3309ebd9871`；最终发行文档提交由外部验收单记录。原样完整 runtime full9：**3327/3327 PASS**，自然退出0，fail/cancel/skip/todo均为0。最终发行文档提交、CI与消费者结果由发行附件绑定。此前00783/full8自然3327/3327和0898全新源码消费者3327/3327（host74/security6/legacy25及lint/typecheck通过）是各自快照结果。0898的 [PR CI](https://github.com/louisjia2008-ux/minecraft-companion/actions/runs/40063704497) 状态记为 `历史0898 CI PASS3327/3327（05:07:09 UTC完成）`；它不充当下一冻结的发布门禁。

0898的归档消费者02/03各自使用全新空目录，在官方JDK下载阶段分别经过301.5748秒、301.3471秒自然exit1，原300秒总期限未改；两次均没有完成Java/Minecraft安装、离线复查或采木游戏。安装器改为header300秒、流idle300秒、固定total900秒，不自动重试；runtime core/vendor、正式场景/harness和游戏期限分别保持。安装器专项原命令已加入CI，并在该代码冻结自然通过18/18（14个顶层、4个子用例）；full9宿主74/74已自然通过，同冻结的lint/typecheck、security6/6、legacy25/25也已自然通过；完整runtime3327/3327也已自然通过；后续新消费者和CI由各自实际收据记录。两次失败及新验证须分别保留。

## 执行与分发范围

新 `core/` 由单一决策循环协调目标、生存与维护；自主模式默认关闭，默认四类卡片为家园、储粮、漏斗刷石机和自动熔炉。其他目标由显式 API/专项场景调用。新 core 尚未接入 Electron；桌面仍走 vendor 旧代理和 JSONL 链。本版仅源码开发预览，不分发桌面安装包或第三方依赖 bundle。已验证 Node22.22.0/npm10.9.4，其他较新版未验证。

## 已取得证据

| 层次 | 已观察结果 | 边界 |
|---|---|---|
| 最新原样完整 runtime full13 | **3338/3338 PASS，自然 exit0，0 fail/cancel/skip/todo** | 1f3/722e离线冻结；和a22游戏快照分开绑定 |
| 历史原样完整 runtime full12 | **3333/3335，2fail，自然exit1；0cancel/skip/todo；sourceChanges[]** | 057/0fc1冻结；矿道防御case通过，不抹去独立斜坡/池塘失败 |
| 历史原样完整 runtime full11 | **3335/3335 PASS，自然exit0；0fail/cancel/skip/todo；sourceChanges[]** | 14b9/6a1c离线冻结；最终发行收据另行绑定 |
| 历史原样完整 runtime full7 | **3326/3326 PASS，自然exit0；0fail/cancel/skip/todo；sourceChanges[]** | 离线完整脚本 |
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
