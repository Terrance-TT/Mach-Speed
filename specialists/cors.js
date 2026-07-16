/**
 * Specialist: CORS Configuration
 * Checks if CORS is properly configured for server-side applications.
 */

import { RepoType } from '../contract.js';

export const checkId = 'cors';
export const name = 'CORS Configured';
export const appliesTo = ['deployable', 'server', 'framework'];

const CORS_PATTERNS = [
  /require\(['"]cors['"]\)/,
  /import.*cors/,
  /app\.use\s*\(\s*cors\s*\(/,
  /cors\s*\(/,
  /access-control-allow-origin/i,
  /cors\s*:\s*(true|{)/i,           // Config-based: { cors: true } or { cors: { ... } }
];

// Config files where frameworks often set CORS
const CONFIG_FILE_PATTERNS = /\.(config|rc)\.(js|ts|mjs|cjs)$/;
const API_ROUTE_PATTERNS = /(\/routes?\/|\/api\/|\.route\.)/i;

const LIBRARY_KEYWORDS = /\b(component|library|ui|react|vue|angular|svelte|util|helper|toolkit|sdk|plugin|module|functional)\b/i;

// Well-known library package names (not apps/frameworks)
const WELL_KNOWN_LIBS = /^(lodash|underscore|ramda|moment|dayjs|date-fns|chalk|debug|colors|qs|uuid|bcrypt|semver|glob|minimist|yargs|inquirer|ora|ms|mime|fresh|bytes|vary|methods|parseurl|path-to-regexp|merge-descriptors|content-type|cookie|cookie-signature|encodeurl|escape-html|http-errors|ipaddr\.js|media-typer|on-finished|proxy-addr|range-parser|raw-body|safe-buffer|safer-buffer|setprototypeof|statuses|type-is|unpipe|wrappy|yallist|lru-cache|ini|dotenv|cross-spawn|execa|which|is-[a-z-]+|has-[a-z-]+|p-[a-z-]+)$/i;

function isLibrary(packageJson) {
  if (!packageJson) return false;
  const name = packageJson.name || '';
  const keywords = packageJson.keywords || [];
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies } || {};

  // Signal 1: peerDependencies present (strong signal)
  const hasPeerDeps = !!packageJson.peerDependencies &&
    Object.keys(packageJson.peerDependencies).length > 0;

  // Signal 2: library keywords in package.json
  const hasLibKeyword = keywords.some(k => LIBRARY_KEYWORDS.test(k));

  // Signal 3: name contains "lib" as a word
  const hasLibInName = /\blibs?\b/i.test(name);

  // Signal 4: well-known library by name
  const isWellKnownLib = WELL_KNOWN_LIBS.test(name);

  // Signal 5: monorepo library root — private, no start/dev scripts, no server deps
  // Library monorepos (React, Svelte) only build/test — no dev server.
  // Deployable/framework monorepos (Astro, Supabase) have dev scripts to run apps.
  const hasServerDep = !!(deps.express || deps.fastify || deps.koa || deps.hono || deps.next || deps.nuxt);
  const hasStartScript = !!(packageJson.scripts && packageJson.scripts.start);
  const hasDevScript = !!(packageJson.scripts && packageJson.scripts.dev);
  const isMonorepoLib = packageJson.private === true && !hasStartScript && !hasServerDep && !hasDevScript;

  return hasPeerDeps || hasLibKeyword || hasLibInName || isWellKnownLib || isMonorepoLib;
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    // Defensive: handle types that don't need CORS
    if (repoType === RepoType.LIBRARY || repoType === RepoType.EMPTY || repoType === RepoType.TOOL) {
      const reason = repoType === RepoType.EMPTY ? 'Empty repo' :
                     repoType === RepoType.TOOL ? 'CLI tool' : 'Library';
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: `${reason} — CORS not applicable`,
        findings: [],
      };
    }

    // Secondary defense: detect libraries even if classifier misclassified
    if (isLibrary(packageJson)) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Library (detected from package.json) — CORS not applicable',
        findings: [],
      };
    }

    // ── Check 1: Root package.json for cors dependency ──
    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies } || {};
    if (deps.cors) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: 'CORS dependency found',
        findings: [],
      };
    }

    // ── Check 2: Monorepo sub-packages for cors dependency ──
    const isMonorepo = !!packageJson?.workspaces;
    if (isMonorepo) {
      const subPkgPaths = tree
        .filter(p => /^(packages|apps)\/[^/]+\/package\.json$/.test(p))
        .slice(0, 5);

      for (const pkgPath of subPkgPaths) {
        const pkgContent = await files.get(pkgPath);
        if (!pkgContent) continue;
        try {
          const subPkg = JSON.parse(pkgContent);
          const subDeps = { ...subPkg?.dependencies, ...subPkg?.devDependencies } || {};
          if (subDeps.cors) {
            return {
              checkId,
              status: 'pass',
              confidence: 'high',
              message: `CORS dependency found in ${pkgPath}`,
              findings: [{ file: pkgPath, issue: 'cors dependency detected' }],
            };
          }
        } catch { /* skip invalid JSON */ }
      }
    }

    // ── Check 3: Scan code + config files for CORS patterns ──
    // Priority: config files first (frameworks often configure CORS there),
    // then server/app/index files, then API route files
    const candidateFiles = tree
      .filter(p => {
        if (!/\.(js|ts|mjs|cjs)$/.test(p)) return false;
        if (/(test|spec|example|__tests__|node_modules|dist|build)/.test(p)) return false;
        return CONFIG_FILE_PATTERNS.test(p) ||
               /(server|app|index)/.test(p) ||
               API_ROUTE_PATTERNS.test(p);
      })
      .sort((a, b) => {
        // Config files first
        const aConfig = CONFIG_FILE_PATTERNS.test(a) ? 0 : 1;
        const bConfig = CONFIG_FILE_PATTERNS.test(b) ? 0 : 1;
        if (aConfig !== bConfig) return aConfig - bConfig;
        // Then server/app/index files
        const aServer = /(server|app|index)/.test(a) ? 0 : 1;
        const bServer = /(server|app|index)/.test(b) ? 0 : 1;
        if (aServer !== bServer) return aServer - bServer;
        return 0;
      })
      .slice(0, 7);

    for (const filePath of candidateFiles) {
      const content = await files.get(filePath);
      if (!content) continue;
      for (const pattern of CORS_PATTERNS) {
        if (pattern.test(content)) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `CORS config found in ${filePath}`,
            findings: [{ file: filePath, issue: 'CORS detected' }],
          };
        }
      }
    }

    // ── Check 4: Static site heuristic ──
    // Only for deployables that have source files but no API routes or server files
    const hasSourceFiles = tree.some(p => /\.(js|ts|jsx|tsx|astro|vue|svelte)$/.test(p));
    const hasApiRoutes = tree.some(p => API_ROUTE_PATTERNS.test(p) && /\.(js|ts)$/.test(p));
    const hasServerFiles = tree.some(p => /(server|app|index)/.test(p) && /\.(js|ts)$/.test(p));
    if (repoType === RepoType.DEPLOYABLE && hasSourceFiles && !hasApiRoutes && !hasServerFiles) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'medium',
        message: 'No API routes detected — CORS likely not needed for static site',
        findings: [],
      };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'No CORS configuration found — may be needed for API endpoints',
      findings: [],
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
