const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const processSnapshots = new Map();

function skillSourceDigest(runtimeRoot) {
  // One process executes one frozen source snapshot. Rehashing all modules on
  // every simulated bot creation needlessly competes with physics deadlines.
  if (processSnapshots.has(runtimeRoot)) return processSnapshots.get(runtimeRoot);
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    const absolute = path.join(runtimeRoot, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /\.(?:js|yaml|json)$/.test(entry.name)) {
        hash.update(child.split(path.sep).join('/')); hash.update('\0'); hash.update(fs.readFileSync(path.join(runtimeRoot, child)));
      }
    }
  }
  visit('vendor');
  hash.update(fs.readFileSync(path.join(runtimeRoot, 'package-lock.json')));
  const result = hash.digest('hex');
  processSnapshots.set(runtimeRoot, result);
  return result;
}

module.exports = { skillSourceDigest };
