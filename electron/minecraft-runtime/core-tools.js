'use strict';
// The data-only host boundary. Never expose dependency injection, arbitrary
// goal objects, JavaScript, chat commands or a provider configuration as tools.
const { KNOWLEDGE } = require('./core/knowledge');
const integer = (minimum = 1, maximum = 4096) => ({ type: 'integer', minimum, maximum });
const position = { type: 'object', additionalProperties: false, required: ['x', 'y', 'z'],
  properties: { x: integer(-30000000, 30000000), y: integer(-2048, 2048), z: integer(-30000000, 30000000) } };
const item = { type: 'string', pattern: '^[a-z0-9_]{1,80}$' };
const facing = { type: 'string', enum: ['east', 'south', 'west', 'north'] };
const taskId = { type: 'string', minLength: 1, maxLength: 128 };
const device = { anchor: position, facing, count: integer() };
function schema(properties = {}, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}
const GOAL_SCHEMAS = Object.freeze({
  gatherLogs: schema({ count: integer() }, ['count']),
  homestead: schema({ anchor: position }),
  farm: schema({ center: position, plots: integer(1, 64), bread: integer() }),
  ranch: schema({ center: position, kind: { type: 'string', enum: ['cow', 'sheep', 'mooshroom', 'goat', 'pig', 'chicken', 'rabbit'] },
    target: integer(1, 64), size: integer(4, 32) }),
  gatherMaterials: schema({ chest: position, requirements: { type: 'array', minItems: 1, maxItems: 64,
    items: schema({ key: { type: 'string', enum: Object.keys(KNOWLEDGE) }, count: integer() }, ['key', 'count']) } }, ['chest', 'requirements']),
  cobbleGenerator: schema({ anchor: position, facing, harvest: integer(), collector: { type: 'boolean' } }),
  autoSmelter: schema({ ...device, input: item, output: item, fuel: item }),
  caneFarm: schema(device), mobFarm: schema(device), ironFarm: schema(device),
  carpetDuper: schema(device), railDuper: schema(device), fishing: schema(device),
  netherQuartz: schema({ count: integer(), roam: integer(1, 512) }),
  enterEnd: schema(), endDragon: schema(), endCity: schema({ chests: integer(1, 64) }),
  endJourney: schema({ chests: integer(1, 64), withCity: { type: 'boolean' } }),
});
const CONTROL_SCHEMAS = Object.freeze({
  getStatus: schema(), listTools: schema(), getTask: schema({ taskId }, ['taskId']),
  cancel: schema({ taskId }, ['taskId']), pause: schema({ taskId }, ['taskId']),
  resume: schema({ taskId }, ['taskId']), stopAll: schema(),
});
const TOOLS = Object.entries({ ...GOAL_SCHEMAS, ...CONTROL_SCHEMAS }).map(([name, parameters]) => ({
  name, kind: Object.hasOwn(GOAL_SCHEMAS, name) ? 'goal' : 'control', parameters,
}));

function validate(value, rule, field = 'arguments') {
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(rule.properties, name)) throw new TypeError(`${field}.${name} is unsupported`);
      validate(value[name], rule.properties[name], `${field}.${name}`);
    }
    for (const name of rule.required || []) if (!Object.hasOwn(value, name)) throw new TypeError(`${field}.${name} is required`);
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < rule.minItems || value.length > rule.maxItems) throw new TypeError(`${field} has invalid length`);
    value.forEach((entry, index) => validate(entry, rule.items, `${field}[${index}]`));
  } else if (rule.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum) throw new TypeError(`${field} must be an integer in ${rule.minimum}..${rule.maximum}`);
  } else if (typeof value !== rule.type) throw new TypeError(`${field} must be ${rule.type}`);
  if (rule.enum && !rule.enum.includes(value)) throw new TypeError(`${field} has an unsupported value`);
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) throw new TypeError(`${field} has an invalid format`);
  if (rule.minLength && (!value.trim() || value.length < rule.minLength || value.length > rule.maxLength)) throw new TypeError(`${field} has invalid length`);
}

function validateTool(name, args = {}) {
  if (typeof name !== 'string') throw new TypeError('Tool name must be a string');
  const rule = Object.hasOwn(GOAL_SCHEMAS, name) ? GOAL_SCHEMAS[name] : CONTROL_SCHEMAS[name];
  if (!rule || !Object.hasOwn({ ...GOAL_SCHEMAS, ...CONTROL_SCHEMAS }, name)) throw new TypeError('Unsupported core tool');
  validate(args, rule);
  return args;
}

module.exports = { GOAL_SCHEMAS, TOOLS, validateTool };
