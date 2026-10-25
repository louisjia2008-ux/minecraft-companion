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
  let goal = null; // unique generation: { def, generation, taskId, best, stalls, reasons }
  let generation = 0;
  let paused = false;
  let running = null; // { behavior, controller, promise }
  let deferredTick = null; // a tick put off a turn after a behavior that settled at once
  let deciding = false;
  let disposed = false;
  let disposal = null;

  function assertActive() {
    if (disposed) throw Object.assign(new Error('Brain is disposed'), { code: 'disposed' });
  }

  const correlation = (entry) => entry
    ? { generation: entry.generation, ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }) }
    : {};

  const emit = (type, data = {}) => {
    try { onEvent({ type, at: now(), ...data }); } catch { /* observers never break the loop */ }
  };

  function goalBehavior() {
    if (!goal || paused || disposed) return null;
    const entry = goal;
    const def = entry.def;
    return {
      name: `goal:${def.name}`,
      band: BAND.GOAL,
      want: (state) => (isGoalDone(entry, state) ? 0 : 1),
      run: (ctx) => def.run(ctx),
      isGoal: true,
      goalEntry: entry,
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
        emit('want_error', { behavior: behavior.name, reason: describe(error), ...correlation(behavior.goalEntry) });
      }
      if (want <= 0) continue;
      if (!best || behavior.band > best.band || (behavior.band === best.band && want > bestWant)) {
        best = behavior;
        bestWant = want;
      }
    }
    return best;
  }

  function failGoalEvaluation(entry, state, error, phase) {
    if (!entry || goal !== entry || disposed) return;
    goal = null;
    emit('goal_failed', { goal: entry.def.name, progress: state ? safeProgress(entry.def, state) : null,
      reasons: [`goal_${phase}_error: ${describe(error)}`], ...correlation(entry) });
  }

  function isGoalDone(entry, state) {
    try {
      const result = entry.def.isDone(state);
      if (result && typeof result.then === 'function') {
        // Selection is synchronous. Reject an async predicate rather than
        // treating its Promise as truthy, and consume a possible rejection.
        Promise.resolve(result).catch(() => {});
        throw new TypeError('Goal isDone must be synchronous');
      }
      return Boolean(result);
    } catch (error) {
      failGoalEvaluation(entry, state, error, 'evaluation');
      return true; // a failed definition is no longer eligible to run
    }
  }

  async function settleGoal(entry, state, result, preempted) {
    // Definition identity is not enough: callers may submit the same definition
    // again. Only the invocation which owns this generation may settle it.
    if (!entry || goal !== entry || paused || disposed) return;
    if (isGoalDone(entry, state)) {
      if (goal !== entry || disposed) return;
      goal = null;
      emit('goal_done', { goal: entry.def.name, progress: safeProgress(entry.def, state), ...correlation(entry) });
      return;
    }
    // Being interrupted by survival is not a lack of progress, and neither is
    // waiting out the night: a wait neither spends nor refills the budget.
    if (preempted || result?.waited) return;
    const progress = safeProgress(entry.def, state);
    if (progress > entry.best) {
      entry.best = progress;
      entry.stalls = 0;
      return;
    }
    entry.stalls += 1;
    if (!result.ok) entry.reasons.push(result.reason);
    if (entry.stalls >= (entry.def.noProgressLimit ?? noProgressLimit)) {
      const reasons = entry.reasons.slice(-entry.stalls);
      // A long goal may know a reset worth more rounds before giving up.
      if (typeof entry.def.recover === 'function' && entry.recoveries < (entry.def.maxRecoveries ?? 0)) {
        entry.recoveries += 1;
        entry.stalls = 0;
        emit('goal_recovering', { goal: entry.def.name, progress, attempt: entry.recoveries, reasons, ...correlation(entry) });
        if (goal === entry && !disposed) {
          try { await entry.def.recover(); } catch (error) {
            failGoalEvaluation(entry, state, error, 'recovery');
          }
        }
        return;
      }
      goal = null;
      emit('goal_failed', { goal: entry.def.name, progress, reasons, ...correlation(entry) });
    }
  }

  function recordOutcome(behavior, result) {
    if (disposed || (behavior.isGoal && behavior.goalEntry !== goal)) return;
    if (result.ok) {
      failures.delete(behavior.name);
      return;
    }
    // Goals are bounded by the no-progress budget and pause briefly between
    // failures, so a step that fails instantly cannot burn the budget in a
    // second; other behaviors back off so a failing reflex cannot monopolize the body.
    if (behavior.isGoal) {
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
    const entry = { behavior, controller, preempted: false, startedAt: now() };
    const isCurrent = () => !disposed && (!behavior.isGoal || behavior.goalEntry === goal);
    const ctx = {
      signal: controller.signal,
      perceive,
      record: (type, data) => {
        if (running === entry && !controller.signal.aborted && isCurrent()) {
          emit(type, { ...data, behavior: behavior.name, ...correlation(behavior.goalEntry) });
        }
      },
      ...correlation(behavior.goalEntry),
      behavior: behavior.name,
    };
    entry.promise = Promise.resolve()
      .then(() => controller.signal.aborted || !isCurrent()
        ? { ok: false, reason: 'aborted' } : behavior.run(ctx))
      .then(normalizeResult, (error) => ({ ok: false, reason: describe(error) }))
      .then(async (result) => {
        try {
          if (controller.signal.aborted && result.ok !== true) result = { ok: false, reason: 'aborted' };
          if (isCurrent()) {
            if (!entry.preempted) recordOutcome(behavior, result);
            if (behavior.isGoal) await settleGoal(behavior.goalEntry, safePerceive(), result, entry.preempted);
            // A terminal observer may synchronously submit another goal. Do not
            // let this finished callback perturb that goal's recovery tracking.
            if (!disposed && (!behavior.isGoal || !goal || goal === behavior.goalEntry)) {
              emit('behavior_finished', { behavior: behavior.name, ok: result.ok, reason: result.reason,
                ...correlation(behavior.goalEntry) });
            }
          }
          return result;
        } catch (error) {
          if (behavior.isGoal) failGoalEvaluation(behavior.goalEntry, safePerceive(), error, 'settle');
          else emit('behavior_error', { behavior: behavior.name, reason: describe(error) });
          return { ok: false, reason: describe(error) };
        } finally {
          // Even an evaluator/recovery failure must release the body. Otherwise
          // a rejected settlement leaves running pinned forever.
          if (running === entry) running = null;
          // An immediate settlement must yield to packets before re-planning.
          if (!disposed) {
            if (now() - entry.startedAt < 5) {
              deferredTick = new Promise((resolve) => setImmediate(() => {
                deferredTick = null;
                tick().catch(() => {}).then(resolve);
              }));
            }
            else queueMicrotask(() => { tick().catch(() => {}); });
          }
        }
      });
    running = entry;
    emit('behavior_started', { behavior: behavior.name, band: behavior.band, ...correlation(behavior.goalEntry) });
  }

  async function preempt(reason, entry = running) {
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
      const idleGoal = goal;
      if (idleGoal && !paused && !running && isGoalDone(idleGoal, state)) {
        await settleGoal(idleGoal, state, { ok: true }, false);
      }
      const best = choose(state);
      if (running) {
        const current = running.behavior;
        // A goal replaced by another one of the same name is no longer wanted.
        const stillWanted = candidates().some((b) => b.name === current.name && b.goalEntry === current.goalEntry);
        if (!stillWanted) {
          await preempt('goal_cleared');
        } else if (best && best.band > current.band) {
          emit('preempted', { behavior: current.name, by: best.name, ...correlation(current.goalEntry) });
          await preempt(`preempted_by:${best.name}`);
        } else {
          return;
        }
      }
      // Re-choose after any preemption: the world may have changed while waiting.
      const next = running || disposed ? null : choose(safePerceive() || state);
      if (next) start(next);
    } finally {
      deciding = false;
    }
  }

  return {
    tick,
    setGoal(def, metadata = {}) {
      assertActive();
      validateGoal(def);
      const state = safePerceive();
      const taskId = metadata?.taskId ?? def.metadata?.taskId ?? def.taskId;
      goal = { def, generation: ++generation, taskId, best: state ? safeProgress(def, state) : -Infinity,
        stalls: 0, recoveries: 0, reasons: [] };
      paused = false;
      failures.delete(`goal:${def.name}`);
      emit('goal_set', { goal: def.name, ...correlation(goal) });
    },
    async clearGoal(reason = 'cleared') {
      assertActive();
      const entry = goal;
      const active = running;
      goal = null;
      paused = false;
      // Publish before awaiting abort so an observer never receives an old
      // uncorrelated terminal event after a replacement was installed.
      if (entry) emit('goal_cleared', { goal: entry.def.name, reason, ...correlation(entry) });
      if (active?.behavior.isGoal) await preempt(reason, active);
    },
    /** Ends the goal as failed from outside (a death loop, say). */
    async failGoal(reason = 'failed') {
      assertActive();
      const entry = goal;
      if (!entry) return;
      const state = safePerceive();
      const active = running;
      goal = null;
      paused = false;
      emit('goal_failed', { goal: entry.def.name, progress: state ? safeProgress(entry.def, state) : null,
        reasons: [reason], ...correlation(entry) });
      if (active?.behavior.isGoal) await preempt(reason, active);
    },
    /** Suspend goal work only. Permanent safety behaviors still own the body. */
    async pauseGoal(reason = 'paused') {
      assertActive();
      const active = running;
      if (!paused) {
        paused = true;
        emit('goal_paused', { goal: goal?.def.name || null, reason, ...correlation(goal) });
      }
      if (active?.behavior.isGoal) await preempt(reason, active);
    },
    async resumeGoal() {
      assertActive();
      if (!paused) return;
      paused = false;
      emit('goal_resumed', { goal: goal?.def.name || null, ...correlation(goal) });
      await tick();
    },
    /** Aborts whatever runs now but keeps the goal; the next tick re-plans. */
    async interrupt(reason = 'interrupted') {
      assertActive();
      const active = running;
      emit('interrupted', { reason, behavior: active?.behavior.name || null, ...correlation(active?.behavior.goalEntry) });
      await preempt(reason, active);
    },
    /** Legacy task stop: clears goals, but subsequent ticks keep safety active. */
    async stop(reason = 'stopped') {
      assertActive();
      const entry = goal;
      const active = running;
      goal = null;
      paused = false;
      emit('stopped', { reason, ...correlation(entry) });
      await preempt(reason, active);
    },
    /** Terminal all-stop. No future tick or goal can restart this brain. */
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      goal = null;
      paused = false;
      disposal = preempt('disposed');
      return disposal;
    },
    status() {
      const state = safePerceive();
      return {
        running: running?.behavior.name || null,
        paused,
        disposed,
        goal: goal ? { name: goal.def.name, progress: state ? safeProgress(goal.def, state) : null,
          stalls: goal.stalls, ...correlation(goal) } : null,
        cooldowns: [...failures].filter(([, f]) => f.until > now()).map(([name, f]) => ({ name, until: f.until })),
      };
    },
    /** Join only one goal generation, never an unrelated safety behavior. */
    idleGoal: (goalGeneration) => running?.behavior.goalEntry?.generation === goalGeneration
      && goalGeneration !== undefined ? running.promise : Promise.resolve(),
    /** Resolves once the currently running behavior (if any) has settled. */
    idle: () => running?.promise ?? deferredTick ?? Promise.resolve(),
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
