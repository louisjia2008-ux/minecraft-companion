const { Vec3 } = require("vec3");
const { Movements, goals } = require("mineflayer-pathfinder");

const CARDINALS = Object.freeze([
  { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
]);
const FACES = Object.freeze([
  ...CARDINALS.map(({ x, z }) => ({ x, y: 0, z })),
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
]);
const FLUIDS = new Set(["water", "flowing_water", "lava", "flowing_lava", "bubble_column"]);
const HAZARDS = new Set([
  ...FLUIDS, "fire", "soul_fire", "magma_block", "cactus", "campfire", "soul_campfire",
  "powder_snow", "sweet_berry_bush", "wither_rose", "cobweb", "web", "end_portal",
  "nether_portal", "end_gateway", "pointed_dripstone",
]);
const GRAVITY = new Set(["sand", "red_sand", "gravel", "anvil", "chipped_anvil", "damaged_anvil", "dragon_egg"]);

function position(value) {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new TypeError("Mining positions must have finite x, y and z coordinates");
  }
  return { x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) };
}

function vector(value) { return new Vec3(value.x, value.y, value.z); }
function key(value) { return `${value.x},${value.y},${value.z}`; }
function offset(value, x, y, z) { return { x: value.x + x, y: value.y + y, z: value.z + z }; }
function same(a, b) { return a.x === b.x && a.y === b.y && a.z === b.z; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

function cardinal(value) {
  const named = {
    east: { x: 1, z: 0 }, west: { x: -1, z: 0 },
    south: { x: 0, z: 1 }, north: { x: 0, z: -1 },
  };
  const result = typeof value === "string" ? named[value.toLowerCase()] : value;
  if (!result || !CARDINALS.some((item) => item.x === result.x && item.z === result.z)) {
    throw new TypeError("Mining direction must be one cardinal horizontal block");
  }
  return { x: result.x, z: result.z };
}

function classifyMiningBlock(block) {
  const name = String(block?.name || "");
  const loaded = Boolean(block && name);
  const properties = typeof block?.getProperties === "function" ? block.getProperties() : {};
  const fluid = FLUIDS.has(name) || properties.waterlogged === true || properties.waterlogged === "true";
  const hazard = fluid || HAZARDS.has(name);
  const gravity = GRAVITY.has(name) || name.endsWith("_concrete_powder");
  const shapes = Array.isArray(block?.shapes) ? block.shapes : null;
  const fullCube = shapes
    ? shapes.some((shape) => shape.length === 6 && shape.every((n, index) => n === (index < 3 ? 0 : 1)))
    : block?.boundingBox === "block";
  const passable = loaded && !hazard && (shapes ? shapes.length === 0 : block.boundingBox === "empty");
  const support = loaded && fullCube && !hazard && !gravity && !name.endsWith("_leaves");
  return {
    loaded, name: name || null, passable, support, fluid, hazard, gravity,
    diggable: loaded && block.diggable !== false && !hazard && !gravity && !['ice','frosted_ice'].includes(name),
  };
}

function failure(code, reason, extra = {}) { return { ok: false, code, reason, ...extra }; }

function hasMiningFootSupport(blockAt,point,{allowLeafSupport=false,allowStableGravitySupport=false}={}) {
    const read=p=>classifyMiningBlock(blockAt(vector(p)));
    const cell=read(point);
    if(cell.support)return true;
    if(allowStableGravitySupport===true&&cell.gravity&&!cell.hazard){
      // Walking on a loaded sand/gravel column is different from excavating
      // it. Require observed full cubes down to a stable dry base; unknown,
      // floating or fluid-supported columns remain unavailable.
      for(let depth=0;depth<=16;depth++){
        const p=offset(point,0,-depth,0),b=blockAt(vector(p)),c=classifyMiningBlock(b);
        if(c.support)return true;
        if(!c.loaded||c.hazard||!c.gravity||!b.shapes?.some(s=>s.length===6&&s.every((n,i)=>n===(i<3?0:1))))return false;
      }
      return false;
    }
    if(allowLeafSupport!==true || !cell.loaded || cell.hazard || cell.gravity || !cell.name.endsWith("_leaves"))return false;
    const block=blockAt(vector(point));
    return Array.isArray(block?.shapes)&&block.shapes.some(shape=>shape.length===6&&shape.every((n,i)=>n===(i<3?0:1)));
}

function inspectMiningStep({ blockAt, from: rawFrom, direction: rawDirection, descend = false, ascend = false, minY = 0, maxY = 255, allowLeafSupport = false, allowCeilingClearance = false, allowStableGravitySupport = false }) {
  const from = position(rawFrom);
  const direction = cardinal(rawDirection);
  if (descend && ascend) throw new TypeError("Mining step cannot descend and ascend together");
  const target = offset(from, direction.x, descend ? -1 : ascend ? 1 : 0, direction.z);
  const floor = offset(target, 0, -1, 0);
  const clearance = [];
  for (let y = Math.max(from.y, target.y) + 1; y >= target.y; y -= 1) {
    clearance.push({ x: target.x, y, z: target.z });
  }
  if (ascend && allowCeilingClearance === true) clearance.unshift(offset(from,0,2,0));
  const detail = { from, target, floor, clearance };
  if (floor.y < minY || clearance.some((cell) => cell.y > maxY)) {
    return failure("MINING_WORLD_BOUNDARY", "矿道已到达当前世界的高度边界", detail);
  }
  const read = (point) => classifyMiningBlock(blockAt(vector(point)));
  // Surface passage clearing may begin on a genuinely loaded dry canopy.
  // Keep ordinary mining's original stable-floor contract by default, without
  // changing any observed block name, collision shape or native physics.
  const support=point=>hasMiningFootSupport(blockAt,point,{allowLeafSupport,allowStableGravitySupport});
  for (const point of [from, offset(from, 0, 1, 0), offset(from, 0, -1, 0), ...clearance, floor]) {
    const cell = read(point);
    if (!cell.loaded) return failure("MINING_UNLOADED", "前方区块尚未加载，停止挖掘", { ...detail, position: point });
    if (cell.hazard) return failure("MINING_FLUID", `矿道附近存在 ${cell.name}，需要绕路`, { ...detail, position: point });
  }
  if (!support(offset(from, 0, -1, 0))) {
    return failure("MINING_NO_SUPPORT", "当前位置下方没有稳定实心地板", detail);
  }
  if (ascend && allowCeilingClearance !== true && !read(offset(from, 0, 2, 0)).passable) {
    return failure("MINING_OBSTRUCTED", "回程阶梯上方空间不足，停止移动", detail);
  }
  for (const point of clearance) {
    const cell = read(point);
    if (cell.gravity) return failure("MINING_GRAVITY", "前方有可能坠落的沙砾或重力方块", { ...detail, position: point });
    if (!cell.passable && !cell.diggable) {
      return failure("MINING_OBSTRUCTED", `前方 ${cell.name} 无法安全挖掘`, { ...detail, position: point });
    }
    for (const face of FACES) {
      const nearby = offset(point, face.x, face.y, face.z);
      const adjacent = read(nearby);
      if (!adjacent.loaded) return failure("MINING_UNLOADED", "挖掘面附近有未知区块", { ...detail, position: nearby });
      // Digging beside water can flood the route. Walking through a genuinely
      // empty, dry cell beside it does not open a channel. The body, support
      // and every live movement tick still reject actual water entry.
      if (adjacent.hazard && !(cell.passable && adjacent.name === "water")) return failure("MINING_FLUID", `挖掘面相邻 ${adjacent.name}，停止开挖`, { ...detail, position: nearby });
      if (face.y === 1 && adjacent.gravity) {
        return failure("MINING_GRAVITY", "矿道上方有可能坠落的沙砾或重力方块", { ...detail, position: nearby });
      }
    }
  }
  const floorCell = read(floor);
  if (!support(floor) && !floorCell.passable) {
    return failure(floorCell.gravity ? "MINING_GRAVITY" : "MINING_NO_SUPPORT", "前方地板不稳定，不能踏入", detail);
  }
  if (!support(floor)) {
    for (const face of FACES) {
      const nearby = offset(floor, face.x, face.y, face.z);
      const adjacent = read(nearby);
      if (!adjacent.loaded) return failure("MINING_UNLOADED", "搭桥支撑位置附近有未知区块", { ...detail, position: nearby });
      if (adjacent.hazard) return failure("MINING_FLUID", "搭桥支撑位置紧邻流体或危险方块，需要绕路", { ...detail, position: nearby });
    }
  }
  // Empty caves can receive one checked support block. Unknown space, fluid and
  // loose gravel are never treated as a bridgeable floor.
  return { ok: true, ...detail, needsSupport: !support(floor) };
}

function createNavigationError(result) {
  const error = new Error(result.reason || "矿道暂时不能安全通过");
  error.code = result.code || "MINING_OBSTRUCTED";
  error.position = result.position || result.target || null;
  return error;
}

function createMiningNavigator(options = {}) {
  if (typeof options.getBot !== "function") throw new TypeError("Mining navigator requires getBot");
  const assertActive = options.assertActive || (() => {});
  const pause = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxActions = Math.max(1, Math.min(100000, Math.floor(options.maxActions || 4096)));
  const restored = options.restoredState || {};
  const breadcrumbs = Array.isArray(restored.breadcrumbs) ? restored.breadcrumbs.slice(0, 8192).map(position) : [];
  const state = {
    breadcrumbs,
    routeIndex: breadcrumbs.length ? Math.max(0, Math.min(breadcrumbs.length - 1, Number.isFinite(restored.routeIndex) ? Math.floor(restored.routeIndex) : breadcrumbs.length - 1)) : 0,
    dug: Math.max(0, Math.floor(Number(restored.dug) || 0)),
    moves: Math.max(0, Math.floor(Number(restored.moves) || 0)),
  };
  // Limits are per invocation; retained counters are useful progress evidence,
  // and do not permanently prevent an explicitly resumed expedition.
  let actions = 0;
  let lastHeartbeat = 0;

  function bot() {
    assertActive();
    const active = options.getBot();
    if (!active?.entity?.position || typeof active.blockAt !== "function") throw new Error("Minecraft 机器人尚未准备好");
    return active;
  }

  function getState() { return { ...state, breadcrumbs: state.breadcrumbs.map((point) => ({ ...point })) }; }
  function save(kind) {
    options.checkpoint?.(getState());
    // Only actual dig/move/place effects refresh the execution watchdog.
    options.heartbeat?.({ kind, position: position(bot().entity.position), dug: state.dug, moves: state.moves });
    lastHeartbeat = Date.now();
  }
  function consumeAction() {
    assertActive();
    if (actions >= maxActions) throw createNavigationError(failure("MINING_LIMIT", "本轮挖矿行动已达到上限，可以保留进度后继续"));
    actions += 1;
  }
  function bounds(active) {
    const version = String(active.version || active.registry?.version?.minecraftVersion || "").match(/^1\.(\d+)/);
    const modern = Boolean(version && Number(version[1]) >= 18);
    const minY = Number.isFinite(options.minY) ? options.minY
      : Number.isFinite(active.game?.minY) ? active.game.minY : modern ? -64 : 0;
    const height = Number.isFinite(options.height) && options.height > 0 ? options.height
      : Number.isFinite(active.game?.height) && active.game.height > 0 ? active.game.height : modern ? 384 : 256;
    return { minY, maxY: minY + height - 1, allowLeafSupport: options.allowLeafSupport === true, allowCeilingClearance: options.allowCeilingClearance === true,
      allowStableGravitySupport: options.allowStableGravitySupport === true };
  }
  function inspectCell(point) {
    const pos = position(point);
    return { position: pos, ...classifyMiningBlock(bot().blockAt(vector(pos))) };
  }
  function isRouteFloor(point) {
    return state.breadcrumbs.some((cell) => cell.x === point.x && cell.z === point.z && cell.y - 1 === point.y);
  }
  function inspect(from, direction, step = {}) {
    const active = bot();
    return inspectMiningStep({ blockAt: active.blockAt.bind(active), from, direction, ...step, ...bounds(active) });
  }
  function stop(active) {
    active.pathfinder?.setGoal?.(null);
    active.clearControlStates?.();
  }

  async function checkedMove(from, target, retreating = false) {
    const active = bot();
    const direction = { x: target.x - from.x, z: target.z - from.z };
    const step = { descend: target.y < from.y, ascend: target.y > from.y };
    const verify = () => {
      // A captured survival owner may temporarily replace this profile or
      // knock the body off the checked edge. Observe no route completion while
      // it owns controls; all dig/checkpoint mutations keep assertActive.
      if (options.isOwnedDefenseActive?.() === true) return;
      assertActive();
      const result = inspect(from, direction, step);
      if (!result.ok) throw createNavigationError(result);
      if (result.needsSupport || result.clearance.some((point) => !inspectCell(point).passable)) {
        throw createNavigationError(failure("MINING_ROUTE_CHANGED", "已检查的矿道发生变化，停止移动", { target }));
      }
    };
    verify();
    // Searching has a finite action budget. Backtracking a finite saved route
    // is still allowed after that budget is spent, so the limit does not trap
    // the bot underground immediately before a safety retreat.
    if (retreating) assertActive();
    else consumeAction();
    if (typeof options.moveTo === "function") {
      // Dependency injection for deterministic voxel-world fixtures.
      await options.moveTo(vector(target), { from: { ...from }, canDig: false, canPlace: false });
      assertActive();
    } else {
      if (!active.pathfinder?.goto || !active.pathfinder?.setMovements) throw new Error("安全矿道移动需要 pathfinder");
      const previous = active.pathfinder.movements;
      const movements = options.preserveMovements===true?previous:new Movements(active);
      if(options.preserveMovements===true){
        if(!movements||movements.canDig!==false||movements.scafoldingBlocks?.length||movements.allowParkour!==false
          ||movements.allow1by1towers!==false||movements.allowSprinting!==false||movements.allowFreeMotion!==false
          ||!Number.isFinite(movements.maxDropDown)||movements.maxDropDown<0||movements.maxDropDown>2||movements.infiniteLiquidDropdownDistance!==false)
          throw createNavigationError(failure("MINING_PROFILE_UNSAFE","原移动配置不适合保留并执行受限步进"));
      }else{
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowFreeMotion = false;
      movements.allowParkour = false;
      movements.allowSprinting = false;
      movements.canOpenDoors = false;
      // pathfinder 2.4.5 compares the starting feet with the landing support
      // block, so a one-block feet descent requires a value of two here.
      // inspectMiningStep and the confined columns still permit only one step.
      movements.maxDropDown = 2;
      movements.infiniteLiquidDropdownDistance = false;
      movements.scafoldingBlocks = [];
      const columns = new Set([`${from.x},${from.z}`, `${target.x},${target.z}`]);
      movements.exclusionAreasStep.push((block) => columns.has(`${block.position.x},${block.position.z}`) ? 0 : 1000);
      movements.exclusionAreasPlace.push(() => 1000);
      movements.exclusionAreasBreak.push(() => 1000);
      for (const name of HAZARDS) if (active.registry.blocksByName[name]) movements.blocksToAvoid.add(active.registry.blocksByName[name].id);
      }
      if(options.preserveMovements!==true)active.pathfinder.setMovements(movements);
      let ownGoal=null;
      // A later action can retain this same profile and survival lease.
      // Only our exact goal (or its already-cleared idle state) may be stopped;
      // a delayed finally must not cancel the replacement actor's goal.
      const ownsMovement = () => active.pathfinder.movements === movements&&ownGoal!==null
        &&(active.pathfinder.goal===ownGoal||active.pathfinder.goal===null);
      let timer;
      let timeout;
      let rejectGuard;
      let guardFailure;
      const guard = new Promise((resolve, reject) => { rejectGuard = reject; });
      const check = () => {
        try { verify(); } catch (error) {
          if (guardFailure) return;
          guardFailure = error;
          if (ownsMovement()) stop(active);
          rejectGuard(error);
        }
      };
      try {
        active.on?.("blockUpdate", check);
        active.on?.("physicsTick", check);
        timer = setInterval(check, 100);
        timeout = setTimeout(() => {
          const error = createNavigationError(failure("MINING_MOVEMENT_TIMEOUT", "矿道移动超时，已停止并保留位置", { target }));
          guardFailure = error;
          if (ownsMovement()) stop(active);
          rejectGuard(error);
        }, Math.max(1000, Number(options.movementTimeoutMs) || 12000));
        const goal = ownGoal = new goals.GoalBlock(target.x, target.y, target.z);
        const movement = typeof options.goto === "function" ? options.goto(goal) : active.pathfinder.goto(goal);
        try {
          await Promise.race([movement, guard]);
          // GoalBlock can complete as soon as the falling feet enter the goal
          // cell, while the player is still almost a block above its floor.
          // Keep the same safety guard and original movement deadline alive
          // until physics confirms landing, before another dig can begin.
          if (typeof active.entity.onGround === "boolean") {
            const landingDeadline = Date.now() + 1500;
            while (!(active.entity.onGround
              && Math.abs(active.entity.position.y - target.y) <= 0.075
              && same(position(active.entity.position), target))) {
              verify();
              if (Date.now() >= landingDeadline) {
                throw createNavigationError(failure("MINING_MOVEMENT_TIMEOUT", "服务器未确认矿道落脚点已站稳，已停止并保留位置", { target }));
              }
              await Promise.race([pause(25), guard]);
            }
          }
        }
        catch (error) { throw guardFailure || error; }
        if (guardFailure) throw guardFailure;
        assertActive();
      } finally {
        clearInterval(timer);
        clearTimeout(timeout);
        active.removeListener?.("blockUpdate", check);
        active.removeListener?.("physicsTick", check);
        // A rejected guard does not authorize restoring a profile over the
        // survival actor. Its exact captured owner must finish first.
        await options.settleOwnedDefense?.();
        if (ownsMovement()) {
          stop(active);
          if (previous) active.pathfinder.setMovements(previous);
        }
      }
    }
    const actual = position(active.entity.position);
    if (!same(actual, target)) throw createNavigationError(failure("MINING_ROUTE_CHANGED", "服务器没有确认到达安全矿道落脚点", { position: actual }));
    verify();
    state.moves += 1;
  }

  function ensureOrigin() {
    const current = position(bot().entity.position);
    if (!state.breadcrumbs.length) {
      state.breadcrumbs.push(current);
      state.routeIndex = 0;
      options.checkpoint?.(getState());
    }
    return current;
  }

  function inspectDig(point) {
    const active = bot();
    const pos = position(point);
    const floor = offset(position(active.entity.position), 0, -1, 0);
    if (same(floor, pos)) return failure("MINING_NO_SUPPORT", "不能挖掉机器人脚下的支撑方块", { position: pos });
    if (isRouteFloor(pos)) {
      return failure("MINING_NO_SUPPORT", "这块矿石支撑着已记录的回程矿道，需要保留", { position: pos });
    }
    if (pos.y < Math.floor(active.entity.position.y) - 1) {
      return failure("MINING_OUT_OF_REACH", "矿石位于矿道地板下方，需要先沿安全阶梯靠近", { position: pos });
    }
    const cell = classifyMiningBlock(active.blockAt(vector(pos)));
    if (!cell.loaded) return failure("MINING_UNLOADED", "目标方块尚未加载", { position: pos });
    if (cell.hazard) return failure("MINING_FLUID", "不能挖掘危险方块", { position: pos });
    if (cell.gravity) return failure("MINING_GRAVITY", "不能挖掘可能坠落的沙砾方块", { position: pos });
    if (!cell.passable && !cell.diggable) return failure("MINING_OBSTRUCTED", "目标方块不能安全挖掘", { position: pos });
    for (const face of FACES) {
      const near = offset(pos, face.x, face.y, face.z);
      const neighbor = classifyMiningBlock(active.blockAt(vector(near)));
      if (!neighbor.loaded) return failure("MINING_UNLOADED", "目标方块相邻未知区块", { position: near });
      if (neighbor.hazard) return failure("MINING_FLUID", `目标方块相邻 ${neighbor.name}，不能开挖`, { position: near });
      if (face.y === 1 && neighbor.gravity) return failure("MINING_GRAVITY", "目标方块上方可能坠落", { position: near });
    }
    const head = { x: active.entity.position.x, y: active.entity.position.y + (active.entity.eyeHeight || 1.62), z: active.entity.position.z };
    if (distance(head, offset(pos, 0.5, 0.5, 0.5)) > 4.5) return failure("MINING_OUT_OF_REACH", "目标方块不在安全挖掘距离内", { position: pos });
    return { ok: true, empty: cell.passable };
  }

  async function checkedDig(point) {
    // An already empty clearance cell needs no digging permission or packet.
    // checkedMove independently verifies its live body and support geometry.
    const existing=inspectCell(point);
    if(existing.loaded&&existing.passable)return false;
    let result = inspectDig(point);
    if (!result.ok) throw createNavigationError(result);
    if (result.empty) return false;
    const active = bot();
    let block = active.blockAt(vector(point));
    await options.equipForBlock?.(block);
    assertActive();
    result = inspectDig(point);
    if (!result.ok) throw createNavigationError(result);
    block = active.blockAt(vector(point));
    if (typeof block.canHarvest === "function" && !block.canHarvest(active.heldItem?.type ?? null)
      &&options.canOpenWithoutHarvest?.(block)!==true) {
      throw createNavigationError(failure("MINING_TOOL_REQUIRED", `当前工具无法获得 ${block.displayName || block.name} 的掉落物`, { position: point }));
    }
    if (typeof active.canDigBlock === "function" && !active.canDigBlock(block)) {
      throw createNavigationError(failure("MINING_OUT_OF_REACH", "目标矿石暂时无法安全挖掘", { position: point }));
    }
    consumeAction();
    let timer;
    let timeout;
    let rejectGuard;
    let guardFailure;
    const guard = new Promise((resolve, reject) => { rejectGuard = reject; });
    const abortDig = (error) => {
      if (guardFailure) return;
      guardFailure = error;
      // A paused run can finish unwinding after the replacement run has
      // already equipped a tool or started another movement/dig operation.
      // Cancel only the dig which this invocation actually started.
      if (!("targetDigBlock" in active) || active.targetDigBlock === block) {
        try {
          const stopped = active.stopDigging?.();
          stopped?.catch?.(() => {});
        } catch { /* The physical operation may already have been cancelled. */ }
      }
      let currentRun = true;
      try { assertActive(); } catch { currentRun = false; }
      if (currentRun) stop(active);
      rejectGuard(error);
    };
    const check = () => {
      try {
        assertActive();
        const safety = inspectDig(point);
        if (!safety.ok) throw createNavigationError(safety);
        const standing = position(active.entity.position);
        for (const body of [standing, offset(standing, 0, 1, 0)]) {
          const cell = inspectCell(body);
          if (!cell.loaded || cell.hazard) {
            throw createNavigationError(failure(cell.loaded ? "MINING_FLUID" : "MINING_UNLOADED", "挖掘时当前位置发生危险变化", { position: body }));
          }
        }
        if (!hasMiningFootSupport(active.blockAt.bind(active),offset(standing,0,-1,0),bounds(active))) {
          throw createNavigationError(failure("MINING_NO_SUPPORT", "挖掘时脚下支撑发生变化", { position: standing }));
        }
      } catch (error) { abortDig(error); }
    };
    try {
      active.on?.("blockUpdate", check);
      timer = setInterval(check, 100);
      const digTime = typeof active.digTime === "function" ? active.digTime(block) : 0;
      const timeoutMs = Number.isFinite(digTime) ? Math.max(8000, Math.min(45000, digTime * 2 + 3000)) : 8000;
      timeout = setTimeout(() => abortDig(createNavigationError(failure("MINING_DIG_TIMEOUT", "安全挖掘超时，已经停止并保留进度", { position: point }))), timeoutMs);
      const digging = options.digBlock ? options.digBlock(block) : active.dig(block, true, "raycast");
      try { await Promise.race([digging, guard]); }
      catch (error) { throw guardFailure || error; }
      if (guardFailure) throw guardFailure;
    } finally {
      clearInterval(timer);
      clearTimeout(timeout);
      active.removeListener?.("blockUpdate", check);
    }
    assertActive();
    const after = inspectCell(point);
    if (!after.loaded || !after.passable) {
      throw createNavigationError(failure(after.hazard ? "MINING_FLUID" : "MINING_BLOCK_NOT_REMOVED", "服务器未确认安全挖空目标方块", { position: point }));
    }
    const safetyAfter = inspectDig(point);
    if (!safetyAfter.ok) throw createNavigationError(safetyAfter);
    state.dug += 1;
    save("dig");
    return true;
  }

  async function rejoinRoute(retreating = false) {
    const current = ensureOrigin();
    const desired = state.breadcrumbs[state.routeIndex];
    if (same(current, desired)) return;
    if (distance(current, desired) > 6) throw createNavigationError(failure("MINING_ROUTE_CHANGED", "机器人已离开记录的矿道，请回到矿道后继续"));
    const queue = [{ point: current, path: [] }];
    const seen = new Set([key(current)]);
    let path;
    for (let index = 0; index < queue.length && index < 128; index += 1) {
      const node = queue[index];
      if (same(node.point, desired)) { path = node.path; break; }
      for (const direction of CARDINALS) for (const dy of [0, 1, -1]) {
        const result = inspect(node.point, direction, { ascend: dy > 0, descend: dy < 0 });
        if (!result.ok || result.needsSupport || result.clearance.some((point) => !inspectCell(point).passable)) continue;
        if (distance(result.target, current) > 6 || seen.has(key(result.target))) continue;
        seen.add(key(result.target));
        queue.push({ point: result.target, path: [...node.path, result.target] });
      }
    }
    if (!path) throw createNavigationError(failure("MINING_ROUTE_CHANGED", "工作台附近没有安全路线可重新进入矿道"));
    let from = current;
    for (const target of path) {
      await checkedMove(from, target, retreating);
      save("rejoin");
      from = target;
    }
  }

  function inspectAdvance(from, direction, step = {}) {
    const result = inspect(from, direction, step);
    if (!result.ok) return result;
    if (result.clearance.some(isRouteFloor)) {
      return { ...result, ok: false, code: "MINING_NO_SUPPORT", reason: "这个方向会挖断已记录的回程矿道，改换方向" };
    }
    if (result.needsSupport && typeof options.placeSupport !== "function") {
      return { ...result, ok: false, code: "MINING_NO_SUPPORT", reason: "前方是洞穴，缺少安全搭桥材料" };
    }
    return result;
  }

  // Natural caves and gravel patches can block every immediate down-step.
  // Search a short level corridor before descending. Planning never mutates
  // blocks or position; advance rechecks every actual dig and footstep.
  function planDescentDetour(directions = CARDINALS, maximumSteps = 8, canUseStep = () => true) {
    if(typeof canUseStep!=="function")throw new TypeError("Detour policy must be a synchronous step predicate");
    const origin = ensureOrigin();
    const ordered = directions.map(cardinal);
    const limit = Math.max(1, Math.min(12, Math.floor(maximumSteps)));
    const visitedRoute = new Set(state.breadcrumbs.map(key));
    const queue = [{ point: origin, path: [] }];
    const seen = new Set([key(origin)]);
    for (let index = 0; index < queue.length && index < 256; index += 1) {
      assertActive();
      const node = queue[index];
      for (const direction of ordered) {
        const down = inspectAdvance(node.point, direction, { descend: true });
        if (down.ok && !visitedRoute.has(key(down.target)) && canUseStep(down)===true) {
          return [...node.path, { direction, descend: true }];
        }
      }
      if (node.path.length >= limit) continue;
      for (const direction of ordered) {
        const level = inspectAdvance(node.point, direction);
        if (!level.ok || visitedRoute.has(key(level.target)) || seen.has(key(level.target)) || canUseStep(level)!==true) continue;
        seen.add(key(level.target));
        queue.push({ point: level.target, path: [...node.path, { direction, descend: false }] });
      }
    }
    return null;
  }

  async function advance(direction, step = {}) {
    ensureOrigin();
    if (state.routeIndex >= 8191) throw createNavigationError(failure("MINING_LIMIT", "记录的矿道已达到本任务的安全长度上限"));
    await rejoinRoute();
    const from = position(bot().entity.position);
    let result = inspectAdvance(from, direction, step);
    if (!result.ok) throw createNavigationError(result);
    for (const point of result.clearance) {
      assertActive();
      result = inspectAdvance(from, direction, step);
      if (!result.ok) throw createNavigationError(result);
      await checkedDig(point);
    }
    result = inspectAdvance(from, direction, step);
    if (!result.ok) throw createNavigationError(result);
    if (result.needsSupport) {
      const placeSupport = options.placeSupport;
      if (typeof placeSupport !== "function") throw createNavigationError(failure("MINING_NO_SUPPORT", "前方支撑状态已改变，不能安全搭桥", result));
      consumeAction();
      await placeSupport(vector(result.floor));
      assertActive();
      if (!inspectCell(result.floor).support) throw createNavigationError(failure("MINING_NO_SUPPORT", "服务器未确认洞穴支撑方块", result));
      save("support");
    }
    await checkedMove(from, result.target);
    state.breadcrumbs = state.breadcrumbs.slice(0, state.routeIndex + 1);
    state.breadcrumbs.push(result.target);
    state.routeIndex = state.breadcrumbs.length - 1;
    save("move");
    return { position: { ...result.target }, state: getState() };
  }

  async function travelTo(index) {
    ensureOrigin();
    const retreating = index < state.routeIndex;
    await rejoinRoute(retreating);
    while (state.routeIndex !== index) {
      assertActive();
      const next = state.routeIndex + (index > state.routeIndex ? 1 : -1);
      await checkedMove(state.breadcrumbs[state.routeIndex], state.breadcrumbs[next], retreating);
      state.routeIndex = next;
      save(index > next ? "return" : "retreat");
      if (options.afterRecordedMove) { await options.afterRecordedMove(getState(), { retreating }); assertActive(); }
    }
    return { position: { ...state.breadcrumbs[state.routeIndex] }, state: getState() };
  }

  function confirmObservedRetreat() {
    const active=bot(),current=position(active.entity.position),previous=getState();
    const index=state.breadcrumbs.slice(0,state.routeIndex+1).findLastIndex(p=>same(p,current));
    if(index<0||index>=state.routeIndex||active.entity.onGround!==true||Math.abs(active.entity.position.y-current.y)>.075
      ||!inspectCell(current).passable||!inspectCell(offset(current,0,1,0)).passable||!inspectCell(offset(current,0,-1,0)).support)
      throw createNavigationError(failure('MINING_ROUTE_CHANGED','自卫后没有确认原记录前缀上的实际回退站位'));
    state.routeIndex=index;state.breadcrumbs=state.breadcrumbs.slice(0,index+1);
    options.checkpoint?.(getState());
    return {previous,state:getState(),actual:current,newMoveCredit:false,newDigCredit:false};
  }

  async function retreat({ steps = Infinity, preserveRoute = true } = {}) {
    ensureOrigin();
    const index = Math.max(0, state.routeIndex - Math.max(0, Math.floor(steps)));
    const result = await travelTo(index);
    if (!preserveRoute) {
      state.breadcrumbs = state.breadcrumbs.slice(0, index + 1);
      options.checkpoint?.(getState());
    }
    return { ...result, state: getState() };
  }

  async function returnToFrontier() {
    ensureOrigin();
    return travelTo(state.breadcrumbs.length - 1);
  }

  async function approachDrops(pos, goal) {
    // Ore can be visible several blocks away across an open cave. Reach the
    // drops through checked neighboring cells instead of relying on an item
    // collector that is allowed to pathfind, dig or jump independently.
    const rejected = new Set();
    for (let count = 0; count < 8 && !goal(); count += 1) {
      const current = position(bot().entity.position);
      if (same(current, pos) || (current.x === pos.x && current.z === pos.z)) break;
      const candidates = [];
      for (const direction of CARDINALS) {
        if ((direction.x && Math.sign(pos.x - current.x) !== direction.x)
          || (direction.z && Math.sign(pos.z - current.z) !== direction.z)) continue;
        const desiredY = Math.sign(pos.y - current.y);
        for (const dy of [...new Set([desiredY, 0])]) {
          const step = { ascend: dy > 0, descend: dy < 0 };
          const result = inspect(current, direction, step);
          if (!result.ok || rejected.has(key(result.target))) continue;
          candidates.push({ direction, step, result, cost: distance(result.target, pos) + (result.needsSupport ? 2 : 0) });
        }
      }
      candidates.sort((a, b) => a.cost - b.cost);
      if (!candidates.length) break;
      let moved = false;
      for (const candidate of candidates) {
        try {
          await advance(candidate.direction, candidate.step);
          moved = true;
          break;
        } catch (error) {
          if (!["MINING_FLUID", "MINING_GRAVITY", "MINING_NO_SUPPORT", "MINING_OBSTRUCTED", "MINING_UNLOADED"].includes(error.code)) throw error;
          rejected.add(key(candidate.result.target));
        }
      }
      await options.collectDrops?.({ position: { ...pos }, allowMovement: false });
      assertActive();
      if (!moved) break;
    }
  }

  function scanNearby(names, radius = 12) {
    const active = bot();
    const requested = new Set(Array.isArray(names) ? names : [names]);
    const point = position(active.entity.position);
    const maxDistance = Math.max(1, Math.min(48, Number(radius) || 12));
    let positions;
    if (typeof active.findBlocks === "function") {
      positions = active.findBlocks({ matching: (block) => Boolean(block && requested.has(block.name)), point: vector(point), maxDistance, count: 128, useExtraInfo: true });
    } else {
      positions = [];
      const range = Math.ceil(Math.min(maxDistance, 16));
      for (let x = -range; x <= range; x += 1) for (let y = -range; y <= range; y += 1) for (let z = -range; z <= range; z += 1) {
        const at = offset(point, x, y, z);
        if (distance(point, at) <= maxDistance && requested.has(active.blockAt(vector(at))?.name)) positions.push(at);
      }
    }
    return positions.map((raw) => {
      const pos = position(raw);
      const block = active.blockAt(vector(pos));
      const exposed = FACES.some((face) => classifyMiningBlock(active.blockAt(vector(offset(pos, face.x, face.y, face.z)))).passable);
      let visible = exposed;
      if (exposed && typeof active.canSeeBlock === "function") {
        try { visible = Boolean(active.canSeeBlock(block)); } catch { visible = false; }
      }
      return { position: pos, name: block?.name || null, distance: distance(point, pos), exposed, visible, reachable: visible && inspectDig(pos).ok };
    }).filter((item) => requested.has(item.name) && item.distance <= maxDistance)
      .sort((a, b) => Number(b.reachable) - Number(a.reachable) || Number(b.exposed) - Number(a.exposed) || a.distance - b.distance);
  }

  async function mineVein(rawPosition, { goal = () => false, maxBlocks = 32, getCollectedCount, allowPickupMovement = true } = {}) {
    ensureOrigin();
    const origin = position(rawPosition);
    const initial = bot().blockAt(vector(origin));
    if (!initial) throw createNavigationError(failure("MINING_UNLOADED", "目标矿脉尚未加载"));
    const names = new Set([initial.name]);
    if (initial.name.startsWith("deepslate_")) names.add(initial.name.slice(10));
    else names.add(`deepslate_${initial.name}`);
    const pending = [origin];
    const seen = new Set();
    const limit = Math.max(1, Math.min(64, Math.floor(maxBlocks)));
    let mined = 0;
    while (pending.length && mined < limit && !goal()) {
      assertActive();
      const pos = pending.shift();
      if (seen.has(key(pos))) continue;
      seen.add(key(pos));
      const active = bot();
      if (!names.has(active.blockAt(vector(pos))?.name)) continue;
      const result = inspectDig(pos);
      if (!result.ok) {
        if (!mined) throw createNavigationError(result);
        continue;
      }
      if (typeof active.canSeeBlock === "function" && !active.canSeeBlock(active.blockAt(vector(pos)))) {
        if (!mined) throw createNavigationError(failure("MINING_OUT_OF_REACH", "矿石仍被其他方块挡住，需要先开出安全矿道", { position: pos }));
        continue;
      }
      const collectedBefore = getCollectedCount?.();
      if (await checkedDig(pos)) mined += 1;
      await pause(100);
      assertActive();
      await options.collectDrops?.({ position: { ...pos }, allowMovement: false });
      assertActive();
      const collectedAfter = getCollectedCount?.();
      // A nearby drop may already have entered the real inventory. Walking
      // into every mined cell in that case needlessly creates pickup branches
      // and return trips. Excavation alone never proves item acquisition.
      const pickedUp = Number.isSafeInteger(collectedBefore) && collectedBefore >= 0
        && Number.isSafeInteger(collectedAfter) && collectedAfter > collectedBefore;
      if (allowPickupMovement && !goal() && !pickedUp) await approachDrops(pos, goal);
      for (const face of FACES) {
        const near = offset(pos, face.x, face.y, face.z);
        if (!seen.has(key(near)) && names.has(bot().blockAt(vector(near))?.name)) pending.push(near);
      }
    }
    return { mined, state: getState(), lastHeartbeat };
  }

  return { getActionCount:()=>actions, inspectCell, advance, retreat, confirmObservedRetreat, returnToFrontier, scanNearby, mineVein, getState, planDescentDetour };
}

module.exports = { CARDINALS, classifyMiningBlock, inspectMiningStep, createMiningNavigator };
