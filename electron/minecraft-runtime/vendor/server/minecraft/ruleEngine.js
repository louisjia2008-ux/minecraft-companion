const fs = require("fs");

const DEFAULT_PERCEPTION_RULES_YAML = `
rules:
  - id: low_health
    signal: signal.low_health
    source: perception_tick
    priority: 95
    from: self
    pick: first
    tags: [health]
    when:
      field: health
      operator: <=
      value: 8
  - id: hostile_nearby
    signal: signal.hostile_nearby
    source: perception_tick
    priority: 100
    from: nearbyHostiles
    pick: first
    tags: [combat, reflex]
    when:
      field: distance
      operator: <=
      value: 4.5
  - id: item_nearby
    signal: signal.item_nearby
    source: perception_tick
    priority: 50
    from: nearbyItems
    pick: first
    tags: [item, reflex]
    when:
      field: distance
      operator: <=
      value: 4.5
`.trim();

const DEFAULT_REFLEX_RULES_YAML = `
rules:
  - id: evade_hostile_close
    kind: event
    event: signal.hostile_nearby
    reflex: evade_hostile
    priority: 100
    inhibitAI: true
    requiresNoUserTask: true
    cooldownMs: 1800
    when:
      field: payload.distance
      operator: <=
      value: 3.5
  - id: pickup_item_close
    kind: event
    event: signal.item_nearby
    reflex: pickup_item
    priority: 50
    inhibitAI: true
    requiresNoUserTask: true
    cooldownMs: 1200
    when:
      field: payload.distance
      operator: <=
      value: 4.5
  - id: follow_player_command
    kind: command
    match: 跟着我|跟随我|follow me|跟我走|跟我
    reflexPlan: follow_player
    replyText: 我直接跟上你。
    args:
      distance: 2
`.trim();

function parseSimpleYamlValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return trimmed;
}

function parseSimpleYamlRules(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  "));
  const rules = [];
  let currentRule = null;
  let currentSection = "";

  const pushCurrent = () => {
    if (currentRule?.id) {
      rules.push(currentRule);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "");
    if (!line.trim() || line.trim() === "rules:") {
      continue;
    }
    const indent = line.match(/^ */)?.[0]?.length || 0;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      pushCurrent();
      currentRule = {};
      currentSection = "";
      const rest = trimmed.slice(2);
      if (rest.includes(":")) {
        const [key, ...restParts] = rest.split(":");
        currentRule[key.trim()] = parseSimpleYamlValue(restParts.join(":"));
      }
      continue;
    }
    if (!currentRule || !trimmed.includes(":")) {
      continue;
    }
    const [key, ...restParts] = trimmed.split(":");
    const parsedValue = parseSimpleYamlValue(restParts.join(":"));
    if (parsedValue === "") {
      currentSection = key.trim();
      currentRule[currentSection] = currentRule[currentSection] || {};
      continue;
    }
    if (indent >= 4 && currentSection) {
      currentRule[currentSection] = currentRule[currentSection] || {};
      currentRule[currentSection][key.trim()] = parsedValue;
      continue;
    }
    currentSection = "";
    currentRule[key.trim()] = parsedValue;
  }
  pushCurrent();
  return rules;
}

function resolveRulePath(target, pathExpression = "") {
  const segments = String(pathExpression || "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current = target;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function compareRuleValue(actual, operator, expected) {
  const normalizedOperator = String(operator || "==").trim();
  if (normalizedOperator === "<=") {
    return Number(actual) <= Number(expected);
  }
  if (normalizedOperator === "<") {
    return Number(actual) < Number(expected);
  }
  if (normalizedOperator === ">=") {
    return Number(actual) >= Number(expected);
  }
  if (normalizedOperator === ">") {
    return Number(actual) > Number(expected);
  }
  if (normalizedOperator === "!=") {
    return actual !== expected;
  }
  if (normalizedOperator === "includes") {
    return Array.isArray(actual)
      ? actual.includes(expected)
      : String(actual || "").includes(String(expected || ""));
  }
  if (normalizedOperator === "regex") {
    try {
      return new RegExp(String(expected || ""), "i").test(String(actual || ""));
    } catch (_) {
      return false;
    }
  }
  return actual === expected;
}

class PerceptionRuleEngine {
  constructor(options = {}) {
    this.rulesPath = options.rulesPath || "";
    this.label = options.label || "感知";
    this.logger =
      typeof options.logger === "function"
        ? options.logger
        : () => {};
    const initialState = this.loadRules();
    this.rules = initialState.rules;
    this.source = initialState.source;
    this.signature = initialState.signature;
  }

  readRulesSource() {
    let raw = DEFAULT_PERCEPTION_RULES_YAML;
    let source = "default";
    try {
      if (this.rulesPath && fs.existsSync(this.rulesPath)) {
        raw = fs.readFileSync(this.rulesPath, "utf8");
        source = "file";
      }
    } catch (error) {
      this.logger(`读取感知规则失败，回退默认规则：${error?.message || error}`);
      return {
        raw: DEFAULT_PERCEPTION_RULES_YAML,
        source: "default",
      };
    }
    return { raw, source };
  }

  createRuleState(rules, source) {
    return {
      rules,
      source,
      signature: JSON.stringify(rules),
    };
  }

  loadRules() {
    const { raw, source } = this.readRulesSource();
    const parsed = this.parseRules(raw);
    if (parsed.length) {
      return this.createRuleState(parsed, source);
    }
    return this.createRuleState(this.parseRules(DEFAULT_PERCEPTION_RULES_YAML), "default");
  }

  parseRules(raw) {
    return parseSimpleYamlRules(raw).filter((rule) => rule?.id && rule?.signal);
  }

  reloadRules() {
    const { raw, source } = this.readRulesSource();
    const parsed = this.parseRules(raw);
    if (source === "file" && !parsed.length) {
      throw new Error(`${this.label}规则解析结果为空，保留上一版规则`);
    }
    const nextState = parsed.length
      ? this.createRuleState(parsed, source)
      : this.createRuleState(this.parseRules(DEFAULT_PERCEPTION_RULES_YAML), "default");
    const changed = nextState.signature !== this.signature;
    this.rules = nextState.rules;
    this.source = nextState.source;
    this.signature = nextState.signature;
    return {
      changed,
      rules: this.rules,
      source: this.source,
    };
  }

  compareValue(actual, operator, expected) {
    return compareRuleValue(actual, operator, expected);
  }

  resolvePath(target, pathExpression = "") {
    return resolveRulePath(target, pathExpression);
  }

  evaluate(snapshot = {}) {
    const events = [];
    for (const rule of this.rules) {
      const sourceValue = this.resolvePath(snapshot, rule.from || "");
      const candidates = Array.isArray(sourceValue)
        ? sourceValue
        : sourceValue && typeof sourceValue === "object"
          ? [sourceValue]
          : [];
      const matched = candidates.filter((candidate) => {
        const fieldValue = this.resolvePath(candidate, rule.when?.field || "");
        if (fieldValue === undefined || fieldValue === null || fieldValue === "") {
          return false;
        }
        return this.compareValue(fieldValue, rule.when?.operator || "==", rule.when?.value);
      });
      const selected =
        rule.pick === "all"
          ? matched
          : matched.length
            ? [matched[0]]
            : [];
      for (const payload of selected) {
        events.push({
          type: String(rule.signal || "").trim(),
          source: String(rule.source || "perception_rule").trim(),
          priority: Number(rule.priority || 0),
          payload,
          tags: Array.isArray(rule.tags) ? rule.tags : [],
        });
      }
    }
    return events;
  }
}

class ReflexRuleEngine {
  constructor(options = {}) {
    this.rulesPath = options.rulesPath || "";
    this.label = options.label || "reflex";
    this.logger =
      typeof options.logger === "function"
        ? options.logger
        : () => {};
    const initialState = this.loadRules();
    this.rules = initialState.rules;
    this.source = initialState.source;
    this.signature = initialState.signature;
  }

  readRulesSource() {
    let raw = DEFAULT_REFLEX_RULES_YAML;
    let source = "default";
    try {
      if (this.rulesPath && fs.existsSync(this.rulesPath)) {
        raw = fs.readFileSync(this.rulesPath, "utf8");
        source = "file";
      }
    } catch (error) {
      this.logger(`读取 reflex 规则失败，回退默认规则：${error?.message || error}`);
      return {
        raw: DEFAULT_REFLEX_RULES_YAML,
        source: "default",
      };
    }
    return { raw, source };
  }

  createRuleState(rules, source) {
    return {
      rules,
      source,
      signature: JSON.stringify(rules),
    };
  }

  loadRules() {
    const { raw, source } = this.readRulesSource();
    const parsed = this.parseRules(raw);
    if (parsed.length) {
      return this.createRuleState(parsed, source);
    }
    return this.createRuleState(this.parseRules(DEFAULT_REFLEX_RULES_YAML), "default");
  }

  parseRules(raw) {
    return parseSimpleYamlRules(raw).filter((rule) => rule?.id);
  }

  reloadRules() {
    const { raw, source } = this.readRulesSource();
    const parsed = this.parseRules(raw);
    if (source === "file" && !parsed.length) {
      throw new Error(`${this.label}规则解析结果为空，保留上一版规则`);
    }
    const nextState = parsed.length
      ? this.createRuleState(parsed, source)
      : this.createRuleState(this.parseRules(DEFAULT_REFLEX_RULES_YAML), "default");
    const changed = nextState.signature !== this.signature;
    this.rules = nextState.rules;
    this.source = nextState.source;
    this.signature = nextState.signature;
    return {
      changed,
      rules: this.rules,
      source: this.source,
    };
  }

  evaluateEvent(event, runtime = {}) {
    return this.rules
      .filter((rule) => String(rule.kind || "event") === "event")
      .filter((rule) => String(rule.event || "").trim() === String(event?.type || "").trim())
      .filter((rule) => {
        if (rule.requiresNoUserTask === true && runtime.hasUserTask === true) {
          return false;
        }
        const fieldPath = String(rule.when?.field || "").trim();
        if (!fieldPath) {
          return true;
        }
        const fieldValue = resolveRulePath(
          {
            event,
            payload: event?.payload || {},
            runtime,
          },
          fieldPath
        );
        if (fieldValue === undefined || fieldValue === null || fieldValue === "") {
          return false;
        }
        return compareRuleValue(fieldValue, rule.when?.operator || "==", rule.when?.value);
      })
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  }

  evaluateCommand(command, context = {}) {
    const text = String(command || "").trim();
    if (!text) {
      return null;
    }
    return (
      this.rules
        .filter((rule) => String(rule.kind || "") === "command")
        .find((rule) => {
          const pattern = String(rule.match || "").trim();
          if (!pattern) {
            return false;
          }
          return compareRuleValue(text, "regex", pattern);
        }) || null
    );
  }
}

module.exports = {
  compareRuleValue,
  parseSimpleYamlRules,
  PerceptionRuleEngine,
  ReflexRuleEngine,
  resolveRulePath,
};
