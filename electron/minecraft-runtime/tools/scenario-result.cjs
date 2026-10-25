'use strict';

function scenarioResult({ run, verdict, timedOut, outcome, durationMs, deaths, harnessFailures = [], goalEvents = [] }) {
  const terminalFailure = outcome?.type === 'goal_failed' || outcome?.type === 'stopped';
  const pass = verdict.pass === true && !timedOut && !terminalFailure && harnessFailures.length === 0;
  const reason = timedOut ? 'timeout' : harnessFailures.length ? `harness_error:${harnessFailures[0]}`
    : outcome?.type === 'goal_failed' ? `goal_failed:${outcome.reasons?.at(-1) || 'unknown'}`
      : outcome?.type === 'stopped' ? `stopped:${outcome.reason || 'unknown'}`
        : verdict.pass !== true ? 'verify_failed' : null;
  // Protected verdict fields come last: a scenario's details cannot overwrite them.
  return { ...verdict.details, run, pass, reason, serverPass: verdict.pass === true,
    timedOut: Boolean(timedOut), durationMs, deaths, brainOutcome: outcome?.type || null,
    failureReasons: outcome?.reasons || [], harnessFailures, goalEvents };
}

function scenarioExitCode(summaries) {
  return summaries.length > 0 && summaries.every((s) => s.runs > 0 && s.passed === s.runs) ? 0 : 1;
}

module.exports = { scenarioResult, scenarioExitCode };
