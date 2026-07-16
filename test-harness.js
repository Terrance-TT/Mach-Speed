// test-harness.js — Validates a specialist follows the contract
// Usage: node test-harness.js specialists/your-check.js

import { validateResult, RepoType } from './contract.js';

async function runTest(specialistPath) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${specialistPath}`);
  console.log('='.repeat(60));

  let module;
  try {
    module = await import(`./${specialistPath}`);
  } catch (err) {
    console.error('FAIL: Could not import module');
    console.error(`  ${err.message}`);
    return false;
  }

  const requiredExports = ['checkId', 'name', 'appliesTo', 'check'];
  const missing = requiredExports.filter(exp => !(exp in module));
  if (missing.length > 0) {
    console.error(`FAIL: Missing exports: ${missing.join(', ')}`);
    return false;
  }
  console.log(`PASS: checkId="${module.checkId}", name="${module.name}", appliesTo=${JSON.stringify(module.appliesTo)}`);

  if (typeof module.check !== 'function') {
    console.error('FAIL: check is not a function');
    return false;
  }

  const mockContext = {
    tree: ['package.json', 'src/index.js', 'README.md'],
    files: { get: async () => '{ "name": "test", "scripts": { "start": "node index.js" } }', has: (p) => ['package.json', 'src/index.js'].includes(p) },
    packageJson: { name: 'test', scripts: { start: 'node index.js' } },
    repoType: RepoType.DEPLOYABLE,
    owner: 'test',
    repo: 'test',
  };

  let result;
  try {
    result = await Promise.race([
      module.check(mockContext),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 10s')), 10000)),
    ]);
  } catch (err) {
    console.error(`FAIL: check() threw: ${err.message}`);
    return false;
  }

  const validation = validateResult(result);
  if (!validation.valid) {
    console.error(`FAIL: Invalid result: ${validation.error}`);
    console.error(JSON.stringify(result, null, 2));
    return false;
  }

  if (result.checkId !== module.checkId) {
    console.error(`FAIL: result.checkId ("${result.checkId}") !== module.checkId ("${module.checkId}")`);
    return false;
  }

  console.log(`PASS: status="${result.status}", confidence="${result.confidence}"`);
  console.log(`PASS: message="${result.message}"`);
  console.log(`PASS: findings=${result.findings.length}`);
  console.log(`\nALL TESTS PASSED`);
  console.log(`${'='.repeat(60)}\n`);
  return true;
}

const path = process.argv[2];
if (!path) { console.log('Usage: node test-harness.js <path-to-specialist>'); process.exit(1); }
runTest(path).then(passed => process.exit(passed ? 0 : 1));
