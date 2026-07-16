/**
 * Specialist: Start Script Check
 * Checks whether package.json has a valid start, serve, or start:prod script.
 *
 * Strategy:
 *   1. Libraries & server frameworks → not-applicable (they don't need start scripts)
 *   2. Monorepos → check-it (start script is in a sub-package, not root)
 *   3. Has start/serve/start:prod → pass
 *   4. Everything else without a start script → fail
 */

export const checkId = 'start-script';
export const name = 'Start Script Present';
export const appliesTo = ['all'];

// ── Well-known library monorepos (root pkg.json lacks library signals) ──
const KNOWN_LIBRARY_MONOREPOS = [
  'facebook/react',
  'vuejs/vue',
  'vuejs/core',
  'angular/angular',
  'sveltejs/svelte',
  'preactjs/preact',
  'solidjs/solid',
  'lit/lit',
];

// ── Well-known server frameworks (importable modules, not standalone apps) ──
const KNOWN_SERVER_FRAMEWORKS = ['express', 'fastify', 'koa', 'hono', '@hono/node-server'];

/**
 * Detect UI libraries even when the root package.json lacks obvious signals.
 * Many library monorepos (React, Vue) have a generic root package.json —
 * the actual library is in packages/react/, packages/vue/, etc.
 */
function isLibraryLike(pkg, owner, repo) {
  if (!pkg) return false;

  // Match by owner/repo (e.g. facebook/react = React library)
  const fullName = `${owner || ''}/${repo || ''}`.toLowerCase();
  if (KNOWN_LIBRARY_MONOREPOS.some(n => fullName.includes(n))) return true;

  // Match by package name
  const name = (pkg.name || '').toLowerCase();
  if (/^react$|^vue$|^angular$|^svelte$|^preact$|^solid-js$|^lit$/.test(name)) return true;

  // peerDependencies + UI keywords = library
  if (pkg.peerDependencies) {
    const kw = pkg.keywords || [];
    if (kw.some(k => /component|library|ui|react|vue|angular|svelte/.test(k))) return true;
  }

  // Explicit "library" keyword
  const keywords = pkg.keywords || [];
  if (keywords.some(k => /\blibrary\b/.test(k))) return true;

  return false;
}

/**
 * Detect server frameworks that apps import (Express, Fastify, Koa, Hono).
 * These don't need a start script — they ARE the framework, not the app.
 */
function isServerFramework(pkg) {
  if (!pkg) return false;

  const name = (pkg.name || '').toLowerCase();

  // Match by exact package name
  if (KNOWN_SERVER_FRAMEWORKS.includes(name)) return true;

  // Framework keyword + server/http keyword + main entry
  const keywords = pkg.keywords || [];
  if (pkg.main && keywords.some(k => /\bframework\b/.test(k))) {
    if (keywords.some(k => /\b(server|http|rest|router|middleware)\b/.test(k))) {
      return true;
    }
  }

  return false;
}

/**
 * Detect monorepos. Root package.json often has no start script because
 * individual apps live in packages/* or apps/* and have their own start scripts.
 */
async function isMonorepo(pkg, tree, files) {
  if (!pkg) return false;

  // npm/yarn workspaces defined in package.json
  if (pkg.workspaces) return true;

  // pnpm workspaces (defined in pnpm-workspace.yaml, not package.json)
  // Check tree first, then try files.get() if tree is empty/unreliable
  if (tree && tree.some(p => p === 'pnpm-workspace.yaml')) return true;
  if (files) {
    try {
      const pnpmWs = await files.get('pnpm-workspace.yaml');
      if (pnpmWs) return true;
    } catch { /* ignore */ }
  }

  // Monorepo tooling
  const devDeps = pkg.devDependencies || {};
  const allDeps = { ...pkg.dependencies, ...devDeps };
  const monoTools = ['turbo', 'lerna', 'nx', '@nrwl/workspace', '@nx/workspace'];
  if (monoTools.some(t => t in devDeps || t in allDeps)) return true;

  // Monorepo directory structure
  if (tree) {
    if (tree.some(p => p === 'packages/' || p.startsWith('packages/'))) return true;
    if (tree.some(p => p === 'apps/' || p.startsWith('apps/'))) return true;
  }

  return false;
}

export async function check(context) {
  const { tree, files, repoType, owner, repo } = context;

  // ── AGGRESSIVE FALLBACK: always try files.get when packageJson is null ──
  // Don't trust files.has() — tree may be incomplete or package.json may be
  // at an unexpected path. Try directly and catch errors.
  let packageJson = context.packageJson;
  if (!packageJson && files) {
    for (const path of ['package.json', 'package.jsonc']) {
      try {
        const raw = await files.get(path);
        if (raw) {
          packageJson = JSON.parse(raw);
          break;
        }
      } catch {
        // Try next path or leave packageJson as null
      }
    }
  }

  try {
    // ── Empty repos ──
    if (repoType === 'empty') {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Empty repo — no start script needed',
        findings: [],
      };
    }

    // ── No package.json at all ──
    if (!packageJson) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'low',
        message: 'No package.json found',
        findings: [],
      };
    }

    const scripts = packageJson.scripts || {};

    // Use 'in' operator to detect empty-string scripts (empty string is falsy in JS)
    const hasStart = 'start' in scripts;
    const hasServe = 'serve' in scripts;
    const hasStartProd = 'start:prod' in scripts;

    // Get actual script values (preserving empty strings)
    const startVal = scripts.start;
    const serveVal = scripts.serve;
    const startProdVal = scripts['start:prod'];

    // ── Determine what kind of repo this really is ──
    const libraryLike = isLibraryLike(packageJson, owner, repo);
    const serverFramework = isServerFramework(packageJson);
    const monorepo = await isMonorepo(packageJson, tree, files);
    const effectiveType = (repoType === 'library' || libraryLike) ? 'library' : repoType;

    // ── UI library — start script is optional ──
    if (effectiveType === 'library') {
      if (hasStart || hasServe || hasStartProd) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: 'Library has start/serve script',
          findings: [],
        };
      }
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'UI library — start script not required',
        findings: [],
      };
    }

    // ── Has a start/serve/start:prod script ──
    if (hasStart || hasServe || hasStartProd) {
      const script = hasStart ? startVal : hasServe ? serveVal : startProdVal;
      const isPlaceholder = script.length <= 3 || script.includes('TODO');

      if (!isPlaceholder) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Start script found: "${script}"`,
          findings: [],
        };
      }

      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: `Start script may be placeholder: "${script}"`,
        findings: [{ file: 'package.json', issue: 'Start script appears to be a placeholder' }],
      };
    }

    // ── No start script found — determine appropriate status ──

    // Server frameworks (Express, Fastify, Koa, Hono) are importable modules
    if (serverFramework) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Server framework — start script not required at root',
        findings: [],
      };
    }

    // ── Monorepos: look for dev/start scripts at root or in turbo config ──
    if (monorepo) {
      const hasDev = 'dev' in scripts;
      const devVal = scripts.dev;

      // Monorepo with a dev script → pass (dev is the modern start)
      if (hasDev && devVal && devVal.length > 3 && !devVal.includes('TODO')) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Monorepo start script found: "${devVal}"`,
          findings: [],
        };
      }

      // No recognizable start mechanism at root → check-it
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: 'Monorepo — no root start script found (may be in a sub-package)',
        findings: [{ file: 'package.json', issue: 'No root start script — check individual packages/' }],
      };
    }

    // ── Genuine failure: non-library, non-monorepo, non-framework with no start script ──
    return {
      checkId,
      status: 'fail',
      confidence: 'high',
      message: 'No start script found in package.json',
      findings: [{ file: 'package.json', issue: 'Missing "start" script — required for deployment' }],
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
