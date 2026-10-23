'use strict';
// Chooses what the bot does next when no player has given it a task.
//
// The director never moves the body. Whenever the brain has had no goal for a
// moment it scores every registered card against the current world and hands
// the brain the most needed goal. A running goal is never re-scored: the next
// choice happens only after it ends, so the bot does not flip between tasks.
// Nothing is remembered about "how far" a goal got; the next choice reads the
// world again, so deaths and player interruptions need no recovery.
//
// A card: { id, stage, risk: 'low'|'medium'|'high', requires?(state, memory),
//           need(state, memory) -> 0..100, create(memory) -> goal }

const RISKS = new Set(['low', 'medium', 'high']);

/** How far a card's need counts right now; risky work waits for daylight and a healthy body. */
function riskFactor(risk, state) {
  if (risk === 'low') return 1;
  const night = state.isDay === false;
  const weak = state.health < 12 || state.food < 8;
  if (risk === 'high') return night || weak ? 0 : 0.8;
  return night ? 0.4 : weak ? 0.6 : 1;
}

/**
 * Pure choice: the highest-scoring eligible card, plus every card's score
 * (and why it was left out) for the event log.
 */
function chooseNext(state, memory, cards, { stage = 0, cooldowns = new Map(), now = Date.now() } = {}) {
  const scores = [];
  let best = null;
  for (const card of cards) {
    const entry = { id: card.id, score: 0 };
    scores.push(entry);
    if (card.stage > stage) { entry.skipped = 'stage'; continue; }
    const cooldown = cooldowns.get(card.id);
    if (cooldown && cooldown.until > now) { entry.skipped = 'cooldown'; continue; }
    try {
      if (card.requires && !card.requires(state, memory)) { entry.skipped = 'requires'; continue; }
      const need = Math.max(0, Math.min(100, Number(card.need(state, memory)) || 0));
      entry.score = Math.round(need * riskFactor(card.risk, state));
    } catch (error) {
      entry.skipped = `error:${error?.message || error}`;
      continue;
    }
    if (entry.score > 0 && (!best || entry.score > best.score)) best = { card, score: entry.score };
  }
  return { card: best?.card || null, scores };
}

function createDirector({
  brain,
  perceive,
  cards = [],
  stageOf = () => 0,
  memory = {},
  now = Date.now,
  onEvent = () => {},
  idleMs = 3000,
  resumeDelayMs = 30000,
  failureCooldownMs = 5 * 60000,
  maxCooldownMs = 60 * 60000,
} = {}) {
  if (!brain || typeof perceive !== 'function') throw new TypeError('brain and perceive are required');
  for (const card of cards) validateCard(card);
  const cooldowns = new Map(); // card id -> { count, until }
  let enabled = false;
  let own = null; // { id, goal }: the goal the director handed the brain
  let playerActive = false;
  let pausedUntil = 0;
  let idleSince = null;
  let lastIdle = false;

  const emit = (type, data = {}) => {
    try { onEvent({ type, at: now(), ...data }); } catch { /* observers never break the loop */ }
  };

  function settle(type, event) {
    const id = own.id;
    own = null;
    if (type === 'goal_done') {
      cooldowns.delete(id);
      return;
    }
    if (type !== 'goal_failed') return;
    const count = (cooldowns.get(id)?.count || 0) + 1;
    const delay = Math.min(maxCooldownMs, failureCooldownMs * 2 ** (count - 1));
    cooldowns.set(id, { count, until: now() + delay });
    emit('autonomy_cooldown', { card: id, count, until: now() + delay, reasons: event.reasons });
  }

  return {
    /** Feed every brain event here. */
    handleEvent(event) {
      if (!event || !['goal_done', 'goal_failed', 'goal_cleared'].includes(event.type)) return;
      if (own && event.goal === own.goal) {
        settle(event.type, event);
      } else if (playerActive) {
        // The player's task is over; give them a moment before taking over again.
        playerActive = false;
        pausedUntil = now() + resumeDelayMs;
      }
    },
    /** A player just set a goal: it replaces whatever the director chose. */
    notePlayerGoal() {
      own = null;
      playerActive = true;
      idleSince = null;
    },
    tick() {
      if (!enabled) return null;
      if (brain.status().goal) { idleSince = null; return null; }
      // A player goal can also end without an event (stop, clear).
      if (playerActive) { playerActive = false; pausedUntil = now() + resumeDelayMs; }
      own = null;
      if (now() < pausedUntil) return null;
      if (idleSince === null) idleSince = now();
      if (now() - idleSince < idleMs) return null;
      const state = perceive();
      if (!state || state.alive === false) return null;
      const stage = stageOf(state, memory);
      const choice = chooseNext(state, memory, cards, { stage, cooldowns, now: now() });
      if (!choice.card) {
        idleSince = now();
        if (!lastIdle) emit('autonomy_idle', { stage, scores: choice.scores });
        lastIdle = true;
        return null;
      }
      lastIdle = false;
      const goal = choice.card.create(memory);
      emit('autonomy_choice', { card: choice.card.id, goal: goal.name, stage, scores: choice.scores });
      brain.setGoal(goal);
      own = { id: choice.card.id, goal: goal.name };
      idleSince = null;
      return choice.card.id;
    },
    enable() {
      if (enabled) return;
      enabled = true;
      idleSince = null;
      emit('autonomy_enabled');
    },
    async disable(reason = 'autonomy_off') {
      if (!enabled) return;
      enabled = false;
      const mine = own;
      own = null;
      if (mine && brain.status().goal?.name === mine.goal) await brain.clearGoal(reason);
      emit('autonomy_disabled', { reason });
    },
    status() {
      return {
        enabled,
        current: own?.id || null,
        playerActive,
        pausedUntil: pausedUntil > now() ? pausedUntil : null,
        cooldowns: [...cooldowns].filter(([, c]) => c.until > now()).map(([id, c]) => ({ id, count: c.count, until: c.until })),
      };
    },
    memory,
  };
}

function validateCard(card) {
  if (!card || typeof card.id !== 'string' || !Number.isFinite(card.stage) || !RISKS.has(card.risk)
      || typeof card.need !== 'function' || typeof card.create !== 'function'
      || (card.requires !== undefined && typeof card.requires !== 'function')) {
    throw new TypeError('Card needs id, stage, risk, need(state, memory) and create(memory)');
  }
  return card;
}

module.exports = { createDirector, chooseNext, riskFactor };
