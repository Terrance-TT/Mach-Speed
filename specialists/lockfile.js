/**
 * Specialist: Lockfile Check
 * Checks if a lockfile is present and not stale for reproducible installs.
 */

export const checkId = 'lockfile';
export const name = 'Lockfile Present';
export const appliesTo = ['all'];

const LOCKFILES = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'deno.lock': 'deno',
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    if (!tree.includes('package.json')) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'No package.json found — lockfile check does not apply',
        findings: []
      };
    }

    const findings = [];
    const presentLockfiles = [];

    for (const [file, manager] of Object.entries(LOCKFILES)) {
      if (tree.includes(file)) {
        findings.push({ file, issue: `Lockfile for ${manager}` });
        presentLockfiles.push({ file, manager });
      }
    }

    if (presentLockfiles.length === 0) {
      const directDeps = packageJson
        ? [
            ...Object.keys(packageJson.dependencies || {}),
            ...Object.keys(packageJson.devDependencies || {}),
            ...Object.keys(packageJson.optionalDependencies || {}),
          ]
        : [];

      const hasWorkspaces = !!packageJson?.workspaces || tree.includes('pnpm-workspace.yaml');

      if (directDeps.length === 0 && !hasWorkspaces) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: 'No lockfile needed — no dependencies declared',
          findings: []
        };
      }

      const isPublishedPackage =
        packageJson &&
        packageJson.private !== true &&
        typeof packageJson.version === 'string' &&
        packageJson.version.length > 0 &&
        (Array.isArray(packageJson.files) ||
          (packageJson.publishConfig && typeof packageJson.publishConfig === 'object'));

      if (isPublishedPackage) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: 'No lockfile present, but not required for published library/framework deployment readiness',
          findings: [
            {
              file: 'package.json',
              issue: 'Published package without lockfile — acceptable for library/framework repos'
            }
          ]
        };
      }

      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: 'No lockfile found — install may not be reproducible',
        findings: [
          {
            file: 'package.json',
            issue: 'Missing lockfile (package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, bun.lock, bun.lockb, or deno.lock)'
          }
        ]
      };
    }

    // Staleness detection
    if (packageJson) {
      const directDeps = new Set([
        ...Object.keys(packageJson.dependencies || {}),
        ...Object.keys(packageJson.devDependencies || {}),
        ...Object.keys(packageJson.optionalDependencies || {}),
      ]);

      if (directDeps.size > 0) {
        for (const { file, manager } of presentLockfiles) {
          const content = await files.get(file);
          if (!content) continue;

          const missingDeps = [];

          try {
            if (file === 'package-lock.json' || file === 'npm-shrinkwrap.json') {
              const lock = JSON.parse(content);
              const locked = new Set();
              let recognized = false;

              if (lock.packages && lock.packages[''] != null) {
                const root = lock.packages[''];
                Object.keys(root.dependencies || {}).forEach(d => locked.add(d));
                Object.keys(root.devDependencies || {}).forEach(d => locked.add(d));
                Object.keys(root.optionalDependencies || {}).forEach(d => locked.add(d));
                recognized = true;
              } else if (lock.dependencies) {
                Object.keys(lock.dependencies).forEach(d => locked.add(d));
                recognized = true;
              }

              if (recognized) {
                for (const dep of directDeps) {
                  if (!locked.has(dep)) missingDeps.push(dep);
                }
              }
            } else if (file === 'yarn.lock') {
              for (const dep of directDeps) {
                const re = new RegExp(`(^|[\\s"'])${escapeRegex(dep)}@`, 'm');
                if (!re.test(content)) missingDeps.push(dep);
              }
            } else if (file === 'pnpm-lock.yaml') {
              for (const dep of directDeps) {
                const re = new RegExp(`(?:^|\\n)\\s*['"]?${escapeRegex(dep)}['"]?\\s*:`, 'm');
                if (!re.test(content)) missingDeps.push(dep);
              }
            } else if (file === 'bun.lock') {
              for (const dep of directDeps) {
                const re = new RegExp(`(^|[\\s"[,])${escapeRegex(dep)}([\\s"\\],:])`, 'm');
                if (!re.test(content)) missingDeps.push(dep);
              }
            }
            // bun.lockb and deno.lock are binary/text formats we skip for content staleness
          } catch (err) {
            console.error(`Error checking staleness of ${file}:`, err);
            continue;
          }

          if (missingDeps.length > 0) {
            findings.push({
              file,
              issue: `Stale lockfile: ${manager} lockfile missing ${missingDeps.join(', ')}`
            });
            return {
              checkId,
              status: 'fail',
              confidence: 'high',
              message: `Lockfile appears stale — ${missingDeps.join(', ')} listed in package.json but missing from ${file}`,
              findings
            };
          }
        }
      }
    }

    const managers = [...new Set(presentLockfiles.map(lf => lf.manager))];
    return {
      checkId,
      status: 'pass',
      confidence: 'high',
      message: `Lockfile found: ${managers.join(', ')}`,
      findings
    };
  } catch (err) {
    console.error('Lockfile specialist error:', err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error: ${err.message}`,
      findings: []
    };
  }
}