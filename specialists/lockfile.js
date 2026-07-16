/**
 * Specialist: Lockfile Check
 * Checks if a lockfile is present for reproducible installs.
 */

export const checkId = 'lockfile';
export const name = 'Lockfile Present';
export const appliesTo = ['all'];

const LOCKFILES = {
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
};

export async function check(context) {
  const { tree, files } = context;

  try {
    // Empty repo guard: no package.json means no dependencies to lock
    if (!tree.includes('package.json')) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'No package.json found — lockfile check does not apply', findings: [] };
    }

    const findings = [];
    for (const [file, manager] of Object.entries(LOCKFILES)) {
      if (tree.includes(file)) {
        findings.push({ file, issue: `Lockfile for ${manager}` });
      }
    }

    if (findings.length > 0) {
      const managers = findings.map(f => f.issue.replace('Lockfile for ', ''));
      return { checkId, status: 'pass', confidence: 'high', message: `Lockfile found: ${managers.join(', ')}`, findings };
    }

    return { checkId, status: 'fail', confidence: 'high', message: 'No lockfile found — install may not be reproducible', findings: [{ file: 'package.json', issue: 'Missing lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, or bun.lockb)' }] };

  } catch (err) {
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [] };
  }
}
