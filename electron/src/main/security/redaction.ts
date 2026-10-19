const SECRET_FIELD = /(?:api[-_]?key|authorization|token|secret|password)/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export const redactSensitive = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return value.replace(BEARER, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_FIELD.test(key) ? '[REDACTED]' : redactSensitive(item)]),
    );
  }
  return value;
};
