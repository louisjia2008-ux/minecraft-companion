'use strict';
// Host CLI; never imported into the bot's registered action set or bridge.
const path = require('node:path');
const { approveHouseSkill } = require('../vendor/server/minecraft/skillApproval');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const values = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (!name?.startsWith('--') || !process.argv[i + 1]) throw Error('Expected --name value arguments');
  values[name.slice(2)] = process.argv[i + 1];
}
try {
  const result = approveHouseSkill({ runtimeRoot: path.resolve(__dirname, '..'),
    catalogFile: values.catalog, approvalFile: values.approvals, candidateId: values.candidate,
    manifestFile: values.manifest, qaFile: values.qa, wholeAuditFile: values.whole, resultFile: values.result,
    expectedHashes: { manifestFile: values['manifest-sha'], qaFile: values['qa-sha'],
      wholeAuditFile: values['whole-sha'], resultFile: values['result-sha'] }, registry: createMinecraftActionRegistry() });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'REJECTED', code: error.code || 'skill_approval_failed' }) + '\n');
  process.exitCode = 1;
}
