/**
 * Specialist: Node.js Version Specification
 * Checks if a Node.js version is specified somewhere in the repo.
 */

export const checkId = 'node-version';
export const name = 'Node.js Version Specified';
export const appliesTo = ['all'];

/**
 * Extract the first non-comment, non-empty line from a version file.
 * Handles files that may contain comments (lines starting with #).
 */
function extractVersion(content) {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      return trimmed;
    }
  }
  return null;
}

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    // 1. Check engines.node in package.json
    if (packageJson?.engines?.node) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: `Node version: "${packageJson.engines.node}"`,
        findings: [],
      };
    }

    // 2. Check volta.node in package.json
    if (packageJson?.volta?.node) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: `Node version in volta: "${packageJson.volta.node}"`,
        findings: [],
      };
    }

    // 3. Monorepo: check sub-package package.json files for engines.node
    // Root may not have engines, but sub-packages often do (e.g., nuxt/packages/nuxt)
    const subPkgPaths = tree.filter(p =>
      /^(?:packages|apps|workspaces|libs)\/[^/]+\/package\.json$/.test(p)
    );
    const checkLimit = Math.min(subPkgPaths.length, 5); // cap to avoid perf issues
    for (let i = 0; i < checkLimit; i++) {
      const subContent = await files.get(subPkgPaths[i]);
      if (subContent) {
        try {
          const subPkg = JSON.parse(subContent);
          if (subPkg.engines?.node) {
            return {
              checkId,
              status: 'pass',
              confidence: 'high',
              message: `Node version in ${subPkgPaths[i]}: "${subPkg.engines.node}"`,
              findings: [],
            };
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // 4. Check .nvmrc file
    if (tree.includes('.nvmrc')) {
      const content = await files.get('.nvmrc');
      const version = extractVersion(content);
      if (version) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Node version in .nvmrc: "${version}"`,
          findings: [],
        };
      }
      // Empty/comment-only file — fall through to next check
    }

    // 5. Check .node-version file
    if (tree.includes('.node-version')) {
      const content = await files.get('.node-version');
      const version = extractVersion(content);
      if (version) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Node version in .node-version: "${version}"`,
          findings: [],
        };
      }
      // Empty/comment-only file — fall through
    }

    // 6. Check .tool-versions file (asdf)
    if (tree.includes('.tool-versions')) {
      const content = await files.get('.tool-versions');
      if (content) {
        const match = content.match(/^node(?:js)?\s+(.+)$/m);
        if (match) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in .tool-versions: "${match[1].trim()}"`,
            findings: [],
          };
        }
      }
    }

    // 7. Check Dockerfile for FROM node:X or FROM node (latest)
    if (tree.includes('Dockerfile')) {
      const content = await files.get('Dockerfile');
      if (content) {
        // Match FROM node:tag or FROM node (whitespace/newline after)
        const match = content.match(/FROM\s+node(?::([^\s\n]+))?/i);
        if (match) {
          const tag = match[1] || 'latest';
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in Dockerfile: "${tag}"`,
            findings: [],
          };
        }
      }
    }

    // Empty repo — no package.json and no version files to check
    // Check the TREE (not just parsed packageJson) because parsing may have failed
    const hasRelevantFiles = tree.includes('package.json') ||
      tree.includes('.nvmrc') ||
      tree.includes('.node-version') ||
      tree.includes('.tool-versions') ||
      tree.includes('Dockerfile');

    if (!hasRelevantFiles) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'No package.json or version files found — empty repo',
        findings: [],
      };
    }

    // Has relevant files but no version spec found
    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'No Node.js version specified (add engines.node to package.json)',
      findings: [{ file: 'package.json', issue: 'Missing engines.node' }],
    };

  } catch (err) {
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error: ${err.message}`,
      findings: [],
    };
  }
}
