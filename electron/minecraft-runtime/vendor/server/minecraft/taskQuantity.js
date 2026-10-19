// Bounded quantities, shared by every parameterized resource task. Coordinates
// remain owned by the coordinate parser; vague requests retain their defaults.
function parseChineseInteger(token) {
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(token)) return NaN;
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百千]/.test(token)) return Number([...token].map(c => digits[c]).join(''));
  let total = 0, digit = 0, lastUnit = Infinity;
  let previousDigit = false;
  for (const c of token) {
    if (c in digits) {
      if (previousDigit && digit !== 0) return NaN;
      digit = digits[c]; previousDigit = true; continue;
    }
    const unit = { 十: 10, 百: 100, 千: 1000 }[c];
    if (!unit || unit >= lastUnit) return NaN;
    total += (digit || 1) * unit;
    digit = 0; lastUnit = unit; previousDigit = false;
  }
  return total + digit;
}

function parseTaskQuantity(command) {
  const text = String(command || '').normalize('NFKC');
  const match = text.match(/(?<![\w.])(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:个|块|根|颗|份|棵|件|把|木头|原木|圆石|石头|钻石|煤炭|铁矿|logs?\b|wood\b|timber\b|cobblestone\b|stone\b|diamonds?\b|iron\b|coal\b|wooden[_ ]pickaxe\b|stone[_ ]pickaxe\b|iron[_ ]pickaxe\b)/i) ||
    text.match(/((?:负)?[零〇一二两三四五六七八九十百千][零〇一二两三四五六七八九十百千点]*)\s*(?:个|块|根|颗|份|棵|件|把|木头|原木|圆石|石头|钻石|煤炭|铁矿)/) ||
    text.match(/(?:\b(?:mine|dig|collect|gather|chop|withdraw|fetch|craft)\b|挖|采(?:集)?|收集|砍|拿|取|做|合成)\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\d.])/i);
  if (!match) return { present: false, value: null, valid: true };
  const value = /^-?\d/.test(match[1]) ? Number(match[1]) : parseChineseInteger(match[1]);
  return { present: true, value, valid: Number.isInteger(value) && value >= 1 && value <= 256 };
}

module.exports = { parseTaskQuantity, parseChineseInteger };
