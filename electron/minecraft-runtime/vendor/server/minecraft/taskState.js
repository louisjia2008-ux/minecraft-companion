const TaskState = Object.freeze({
  PENDING: "pending",
  PLANNING: "planning",
  RUNNING: "running",
  PAUSED: "paused",
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
});

module.exports = {
  TaskState,
};
