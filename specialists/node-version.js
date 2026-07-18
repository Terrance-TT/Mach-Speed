/**
 * Specialist: Node.js Version Specification
 * Checks if a Node.js version is specified somewhere in the repo.
 */

export const checkId = 'node-version';
export const name = 'Node.js Version Specified';
export const appliesTo = ['all'];

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

function isExcludedPath(p) {
  const excluded = ['node_modules', '.git', 'dist', 'build', 'coverage', 'tmp', 'out', 'public', 'static', 'vendor', 'fixtures', '__fixtures__', '__mocks__', '.next', '.turbo', '.svelte-kit'];
  return excluded.some(d => p.includes(`/${d}/`) || p.startsWith(`${d}/`));
}

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    // 1. Root package.json via context
    if (packageJson?.engines?.node) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: `Node version: "${packageJson.engines.node}"`,
        findings: [],
      };
    }
    if (packageJson?.volta?.node) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: `Node version in volta: "${packageJson.volta.node}"`,
        findings: [],
      };
    }

    // 2. If root package.json exists but wasn't parsed by context, try reading it directly
    if (!packageJson && tree.includes('package.json')) {
      const rootContent = await files.get('package.json');
      if (rootContent) {
        try {
          const rootPkg = JSON.parse(rootContent);
          if (rootPkg.engines?.node) {
            return {
              checkId,
              status: 'pass',
              confidence: 'high',
              message: `Node version: "${rootPkg.engines.node}"`,
              findings: [],
            };
          }
          if (rootPkg.volta?.node) {
            return {
              checkId,
              status: 'pass',
              confidence: 'high',
              message: `Node version in volta: "${rootPkg.volta.node}"`,
              findings: [],
            };
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // 3. Broad search for package.json files with engines.node / volta.node
    const pkgPaths = tree
      .filter(p => p.endsWith('package.json') && p !== 'package.json' && !isExcludedPath(p))
      .sort((a, b) => a.split('/').length - b.split('/').length);
    const pkgCap = Math.min(pkgPaths.length, 15);
    for (let i = 0; i < pkgCap; i++) {
      const content = await files.get(pkgPaths[i]);
      if (!content) continue;
      try {
        const pkg = JSON.parse(content);
        if (pkg.engines?.node) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in ${pkgPaths[i]}: "${pkg.engines.node}"`,
            findings: [],
          };
        }
        if (pkg.volta?.node) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in ${pkgPaths[i]} (volta): "${pkg.volta.node}"`,
            findings: [],
          };
        }
      } catch { /* ignore parse errors */ }
    }

    // 4. .nvmrc anywhere in tree
    const nvmrcPaths = tree.filter(p => (p === '.nvmrc' || p.endsWith('/.nvmrc')) && !isExcludedPath(p));
    for (const p of nvmrcPaths.slice(0, 3)) {
      const content = await files.get(p);
      const version = extractVersion(content);
      if (version) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Node version in ${p}: "${version}"`,
          findings: [],
        };
      }
    }

    // 5. .node-version anywhere in tree
    const nodeVersionPaths = tree.filter(p => (p === '.node-version' || p.endsWith('/.node-version')) && !isExcludedPath(p));
    for (const p of nodeVersionPaths.slice(0, 3)) {
      const content = await files.get(p);
      const version = extractVersion(content);
      if (version) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Node version in ${p}: "${version}"`,
          findings: [],
        };
      }
    }

    // 6. .tool-versions (asdf) anywhere in tree
    const toolVersionsPaths = tree.filter(p => (p === '.tool-versions' || p.endsWith('/.tool-versions')) && !isExcludedPath(p));
    for (const p of toolVersionsPaths.slice(0, 3)) {
      const content = await files.get(p);
      if (content) {
        const match = content.match(/^node(?:js)?\s+(.+)$/m);
        if (match) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in ${p}: "${match[1].trim()}"`,
            findings: [],
          };
        }
      }
    }

    // 7. mise.toml / .mise.toml anywhere in tree
    const misePaths = tree.filter(p => /(^|\/)mise\.toml$/.test(p) || /(^|\/)\.mise\.toml$/.test(p));
    for (const p of misePaths.slice(0, 3)) {
      const content = await files.get(p);
      if (content) {
        const match = content.match(/^\s*node(?:js)?\s*=\s*["'](.+?)["']/m);
        if (match) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in ${p}: "${match[1]}"`,
            findings: [],
          };
        }
      }
    }

    // 8. .npmrc (pnpm use-node-version) anywhere in tree
    const npmrcPaths = tree.filter(p => (p === '.npmrc' || p.endsWith('/.npmrc')) && !isExcludedPath(p));
    for (const p of npmrcPaths.slice(0, 3)) {
      const content = await files.get(p);
      if (content) {
        const match = content.match(/^use-node-version\s*=\s*(.+)$/m);
        if (match) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in ${p} (pnpm): "${match[1].trim()}"`,
            findings: [],
          };
        }
      }
    }

    // 9. Dockerfile / docker-compose anywhere in tree
    const dockerPaths = tree.filter(p => /(^|\/)Dockerfile[^/]*$/.test(p) || /(^|\/)docker-compose[^/]*\.ya?ml$/.test(p));
    for (const p of dockerPaths.slice(0, 5)) {
      const content = await files.get(p);
      if (!content) continue;
      if (p.includes('Dockerfile')) {
        const match = content.match(/FROM\s+node(?::([^\s\n]+))?/i);
        if (match) {
          const tag = match[1] || 'latest';
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in ${p}: "${tag}"`,
            findings: [],
          };
        }
      }
      if (p.includes('docker-compose')) {
        const match = content.match(/image:\s*node(?::([^\s\n]+))?/i);
        if (match) {
          const tag = match[1] || 'latest';
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Node version in ${p}: "${tag}"`,
            findings: [],
          };
        }
      }
    }

    // 10. GitHub Actions workflows
    const workflowPaths = tree.filter(p => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
    for (const p of workflowPaths.slice(0, 5)) {
      const content = await files.get(p);
      if (!content) continue;
      const match = content.match(/node-version\s*:\s*["']?([^"\n]+?)["']?$/m);
      if (match && /\d/.test(match[1])) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Node version in ${p}: "${match[1].trim()}"`,
          findings: [],
        };
      }
      const matrixMatch = content.match(/\bnode\s*:\s*(?:\[\s*)?["']?(\d[^"\n\]]*)/m);
      if (matrixMatch) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Node version in ${p} (CI matrix): "${matrixMatch[1].trim()}"`,
          findings: [],
        };
      }
    }

    // Determine applicability based on whether any relevant files exist anywhere in the tree
    const hasRelevantFiles =
      tree.includes('package.json') ||
      pkgPaths.length > 0 ||
      nvmrcPaths.length > 0 ||
      nodeVersionPaths.length > 0 ||
      toolVersionsPaths.length > 0 ||
      misePaths.length > 0 ||
      npmrcPaths.length > 0 ||
      dockerPaths.length > 0 ||
      workflowPaths.length > 0;

    if (!hasRelevantFiles) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'No package.json or version files found',
        findings: [],
      };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'No Node.js version specified (add engines.node to package.json)',
      findings: [{ file: 'package.json', issue: 'Missing engines.node' }],
    };
  } catch (err) {
    console.error(`[${checkId}] Error:`, err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error: ${err.message}`,
      findings: [],
    };
  }
}