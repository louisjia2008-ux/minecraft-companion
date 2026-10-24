'use strict';
// The single decision point for the bot's body.
//
// Every tick re-reads the world and picks exactly one behavior to own the body.
// Tasks never "resume": when an interruption ends, the goal simply looks at the
// current state again and decides what is still missing. Progress lives in the
// world (inventory, placed blocks), not in a step pointer.

const BAND = Object.freeze({ IDLE: 0, GOAL: 50, MAINTENANCE: 100, DEFENSE: 120, ESCAPE: 130 });

function createBrain({
  perceive,
  behaviors = [],
  now = Date.now,
  onEvent = () => {},
  noProgressLimit = 6,
  failureCooldownMs = 2000,
  maxCooldownMs = 30000,
  goalRetryDelayMs = 250,
} = {}) {
  if (typeof perceive !== 'function') throw new TypeError('perceive is required');
  const permanent = behaviors.map(validateBehavior);
  const failures = new Map(); // name -> { count, until }
  let goal = null; // { def, best, stalls, reasons }
  let running = null; // { behavior, controller, promise }
  let deciding = false;
  let disposed = false;

  const emit = (type, data = {}) => {
    try { onEvent({ type, at: now(), ...data }); } catch { /* observers never break the loop */ }
  };

  function goalBehavior() {
    if (!goal) return null;
    const def = goal.def;
    return {
      name: `goal:${def.name}`,
      band: BAND.GOAL,
      want: (state) => (def.isDone(state) ? 0 : 1),
      run: (ctx) => def.run(ctx),
      isGoal: true,
      def,
    };
  }

  function candidates() {
    const list = [...permanent];
    const g = goalBehavior();
    if (g) list.push(g);
    return list;
  }

  function choose(state) {
    let best = null;
    let bestWant = 0;
    for (const behavior of candidates()) {
      const cooldown = failures.get(behavior.name);
      if (cooldown && cooldown.until > now()) continue;
      let want = 0;
      try { want = Number(behavior.want(state)) || 0; } catch (error) {
        emit('want_error', { behavior: behavior.name, reason: describe(error) });
      }
      if (want <= 0) continue;
      if (!best || behavior.band > best.band || (behavior.band === best.band && want > bestWant)) {
        best = behavior;
        bestWant = want;
      }
    }
    return best;
  }

  function settleGoal(state, result, preempted) {
    if (!goal) return;
    if (goal.def.isDone(state)) {
      emit('goal_done', { goal: goal.def.name, progress: safeProgress(goal.def, state) });
      goal = null;
      return;
    }
    // Being interrupted by survival is not a lack of progress, and neither is
    // waiting out the night: a wait neither spends nor refills the budget.
    if (preempted || result?.waited) return;
    const progress = safeProgress(goal.def, state);
    if (progress > goal.best) {
      goal.best = progress;
      goal.stalls = 0;
      return;
    }
    goal.stalls += 1;
    if (!result.ok) goal.reasons.push(result.reason);
    if (goal.stalls >= (goal.def.noProgressLimit ?? noProgressLimit)) {
      // A long goal may know a reset (forget blacklists, go home) worth a few
      // more rounds before giving up for good.
      if (typeof goal.def.recover === 'function' && goal.recoveries < (goal.def.maxRecoveries ?? 0)) {
        goal.recoveries += 1;
        emit('goal_recovering', { goal: goal.def.name, progress, attempt: goal.recoveries, reasons: goal.reasons.slice(-goal.stalls) });
        goal.def.recover();
        goal.stalls = 0;
        return;
      }
      emit('goal_failed', { goal: goal.def.name, progress, reasons: goal.reasons.slice(-goal.stalls) });
      goal = null;
    }
  }

  function recordOutcome(behavior, result) {
    if (result.ok) {
      failures.delete(behavior.name);
      return;
    }
    // Goals are bounded by the no-progress budget and pause briefly between
    // failures, so a step that fails instantly cannot burn the budget in a
    // second; other behaviors back off so a failing reflex cannot monopolize the body.
    if (behavior.isGoal) {
      // A replaced goal's failure says nothing about the goal that replaced it.
      if (behavior.def !== goal?.def) return;
      const stalls = goal?.stalls || 0;
      if (goalRetryDelayMs > 0) {
        failures.set(behavior.name, { count: stalls, until: now() + Math.min(3000, goalRetryDelayMs * (stalls + 1)) });
      }
      return;
    }
    const previous = failures.get(behavior.name);
    const count = (previous?.count || 0) + 1;
    const delay = Math.min(maxCooldownMs, failureCooldownMs * 2 ** (count - 1));
    failures.set(behavior.name, { count, until: now() + delay });
  }

  function start(behavior) {
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      perceive,
      record: (type, data) => emit(type, { behavior: behavior.name, ...data }),
      behavior: behavior.name,
    };
    emit('behavior_started', { behavior: behavior.name, band: behavior.band });
    const entry = { behavior, controller, preempted: false };
    entry.promise = Promise.resolve()
      .then(() => behavior.run(ctx))
      .then(normalizeResult, (error) => ({ ok: false, reason: describe(error) }))
      .then((result) => {
        if (controller.signal.aborted && result.ok !== true) result = { ok: false, reason: 'aborted' };
        recordOutcome(behavior, result);
        if (behavior.isGoal) settleGoal(safePerceive(), result, entry.preempted);
        emit('behavior_finished', { behavior: behavior.name, ok: result.ok, reason: result.reason });
        if (running === entry) running = null;
        if (!disposed) queueMicrotask(() => { tick().catch(() => {}); });
        return result;
      });
    running = entry;
  }

  async function preempt(reason) {
    const entry = running;
    if (!entry) return;
    entry.preempted = true;
    entry.controller.abort(reason);
    await entry.promise;
  }

  function safePerceive() {
    try { return perceive(); } catch { return null; }
  }

  async function tick() {
    if (deciding || disposed) return;
    deciding = true;
    try {
      const state = safePerceive();
      if (!state || state.alive === false) {
        if (running) await preempt('unavailable');
        return;
      }
      if (goal && !running && goal.def.isDone(state)) settleGoal(state, { ok: true }, false);
      const best = choose(state);
      if (running) {
        const current = running.behavior;
        // A goal replaced by another one of the same name is no longer wanted.
        const stillWanted = candidates().some((b) => b.name === current.name && b.def === current.def);
        if (!stillWanted) {
          await preempt('goal_cleared');
        } else if (best && best.band > current.band) {
          emit('preempted', { behavior: current.name, by: best.name });
          await preempt(`preempted_by:${best.name}`);
        } else {
          return;
        }
      }
      // Re-choose after any preemption: the world may have changed while waiting.
      const next = running ? null : choose(safePerceive() || state);
      if (next) start(next);
    } finally {
      deciding = false;
    }
  }

  return {
    tick,
    setGoal(def) {
      validateGoal(def);
      const state = safePerceive();
      goal = { def, best: state ? safeProgress(def, state) : -Infinity, stalls: 0, recoveries: 0, reasons: [] };
      emit('goal_set', { goal: def.name });
    },
    async clearGoal(reason = 'cleared') {
      if (!goal) return;
      const name = goal.def.name;
      goal = null;
      if (running?.behavior.isGoal) await preempt(reason);
      emit('goal_cleared', { goal: name, reason });
    },
    /** Ends the goal as failed from outside (a death loop, say) instead of letting it retry. */
    async failGoal(reason = 'failed') {
      if (!goal) return;
      const { def } = goal;
      const state = safePerceive();
      goal = null;
      if (running?.behavior.isGoal) await preempt(reason);
      emit('goal_failed', { goal: def.name, progress: state ? safeProgress(def, state) : null, reasons: [reason] });
    },
    /** Aborts whatever runs now but keeps the goal; the next tick re-plans. */
    async interrupt(reason = 'interrupted') {
      emit('interrupted', { reason, behavior: running?.behavior.name || null });
      await preempt(reason);
    },
    async stop(reason = 'stopped') {
      goal = null;
      await preempt(reason);
      emit('stopped', { reason });
    },
    async dispose() {
      disposed = true;
      goal = null;
      await preempt('disposed');
    },
    status() {
      const state = safePerceive();
      return {
        running: running?.behavior.name || null,
        goal: goal ? { name: goal.def.name, progress: state ? safeProgress(goal.def, state) : null,
          stalls: goal.stalls } : null,
        cooldowns: [...failures].filter(([, f]) => f.until > now()).map(([name, f]) => ({ name, until: f.until })),
      };
    },
    /** Resolves once the currently running behavior (if any) has settled. */
    idle: () => running?.promise ?? Promise.resolve(),
  };
}

function normalizeResult(value) {
  if (value && typeof value === 'object' && typeof value.ok === 'boolean') return value;
  return { ok: true };
}

function describe(error) {
  return String(error?.code || error?.message || error || 'error');
}

function safeProgress(def, state) {
  try {
    const value = Number(def.progress(state));
    return Number.isFinite(value) ? value : -Infinity;
  } catch {
    return -Infinity;
  }
}

function validateBehavior(behavior) {
  if (!behavior || typeof behavior.name !== 'string' || !Number.isFinite(behavior.band)
      || typeof behavior.want !== 'function' || typeof behavior.run !== 'function') {
    throw new TypeError('Behavior needs name, band, want(state) and run(ctx)');
  }
  return behavior;
}

function validateGoal(def) {
  if (!def || typeof def.name !== 'string' || typeof def.isDone !== 'function'
      || typeof def.progress !== 'function' || typeof def.run !== 'function') {
    throw new TypeError('Goal needs name, isDone(state), progress(state) and run(ctx)');
  }
}

module.exports = { createBrain, BAND };
