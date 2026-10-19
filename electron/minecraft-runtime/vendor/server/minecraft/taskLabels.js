const AUTONOMOUS_PHASE_LABELS = Object.freeze({
  survival: "生存维持",
  pickup: "回收掉落物",
  guard: "保护玩家",
  shelter: "搭建落脚点",
  organize: "整理物资",
  secure: "稳固工作区",
  tools: "补工具链",
  stock: "补基础库存",
  progress: "推进游戏进度",
  endgame: "推进终局主线",
  return: "回到玩家附近",
  wait: "待命观察",
});

const TASK_TURN_PHASE_LABELS = Object.freeze({
  planning: "规划",
  preparing: "准备",
  executing: "执行",
  recovering: "恢复",
  returning: "回位",
  finishing: "收尾",
  paused: "暂停",
  failed: "失败",
});

module.exports = {
  AUTONOMOUS_PHASE_LABELS,
  TASK_TURN_PHASE_LABELS,
};
