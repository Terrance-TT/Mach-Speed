/**
 * Specialist: Build Step Defined
 * Checks if package.json has a build script.
 *
 * Four-layer detection (most to least reliable):
 *   1. Read scripts from context.packageJson (fastest, most reliable)
 *   2. Fallback: read package.json via context.files.get() (handles upstream parse failures)
 *   3. Fallback: GitHub Contents API with base64 decode (different rate-limit bucket)
 *   4. Last resort: scan repo tree for build-tool config files (handles network issues)
 *
 * Server repos without build scripts → not-applicable (they're consumed as dependencies)
 */

import { RepoType } from '../contract.js';

export const checkId = 'build-step';
export const name = 'Build Step Defined';
export const appliesTo = ['all'];

/** Build-tool config files that imply a build step exists.
 *  Used when package.json cannot be read (network/rate-limit issues).
 *  Each pattern is tested against the full file path from the repo tree.
 */
const BUILD_INDICATORS = [
  // Framework configs (these ALWAYS have a build command)
  { pattern: /(^|\/)astro\.config\./,      name: 'Astro config' },
  { pattern: /(^|\/)next\.config\./,       name: 'Next.js config' },
  { pattern: /(^|\/)nuxt\.config\./,       name: 'Nuxt config' },
  { pattern: /(^|\/)svelte\.config\./,     name: 'Svelte config' },
  { pattern: /(^|\/)gatsby-config\./,       name: 'Gatsby config' },
  { pattern: /(^|\/)quasar\.conf\./,       name: 'Quasar config' },
  { pattern: /(^|\/)remix\.config\./,      name: 'Remix config' },

  // Bundler configs (strong build signal)
  { pattern: /(^|\/)vite\.config\./,       name: 'Vite config' },
  { pattern: /(^|\/)webpack\.config\./,    name: 'Webpack config' },
  { pattern: /(^|\/)rollup\.config\./,     name: 'Rollup config' },
  { pattern: /(^|\/)tsup\.config\./,       name: 'Tsup config' },
  { pattern: /(^|\/)parcel\.config\./,     name: 'Parcel config' },
  { pattern: /(^|\/)esbuild\.config\./,    name: 'Esbuild config' },
  { pattern: /(^|\/)rspack\.config\./,     name: 'Rspack config' },
  { pattern: /(^|\/)farm\.config\./,       name: 'Farm config' },
  { pattern: /(^|\/)brunch-config\./,       name: 'Brunch config' },
  { pattern: /(^|\/)fuse\./,                name: 'FuseBox config' },

  // Monorepo build pipelines
  { pattern: /(^|\/)turbo\.json$/,         name: 'Turborepo config' },
  { pattern: /(^|\/)pnpm-workspace\.yaml$/, name: 'PNPM workspace' },
  { pattern: /(^|\/)lerna\.json$/,          name: 'Lerna monorepo' },
  { pattern: /(^|\/)nx\.json$/,             name: 'Nx monorepo' },
  { pattern: /(^|\/)rush\.json$/,           name: 'Rush monorepo' },

  // Container / CI / deployment configs (imply build steps)
  { pattern: /(^|\/)Dockerfile$/,          name: 'Dockerfile' },
  { pattern: /(^|\/)docker-compose/,       name: 'Docker Compose' },
  { pattern: /(^|\/)Makefile$/,            name: 'Makefile' },
  { pattern: /(^|\/)netlify\.toml$/,       name: 'Netlify config' },
  { pattern: /(^|\/)vercel\.json$/,        name: 'Vercel config' },
  { pattern: /(^|\/)railway\.json$/,       name: 'Railway config' },
  { pattern: /(^|\/)render\.yaml$/,        name: 'Render config' },
  { pattern: /(^|\/)fly\.toml$/,           name: 'Fly.io config' },
  { pattern: /(^|\/)app\.yaml$/,           name: 'App Engine config' },
  { pattern: /(^|\/)Procfile$/,            name: 'Heroku Procfile' },
  { pattern: /\.github\/workflows\/.*\.(yml|yaml)$/, name: 'CI workflow' },
  { pattern: /(^|\/)cloudbuild\.yaml$/,    name: 'Cloud Build config' },
  { pattern: /(^|\/)codesandbox\.json$/,   name: 'CodeSandbox config' },

  // Transpiler / type-checker configs that imply a build step
  { pattern: /(^|\/)babel\.config\./,      name: 'Babel config' },
  { pattern: /(^|\/)\.babelrc/,            name: 'Babel config' },
  { pattern: /(^|\/)swc\.config\./,        name: 'SWC config' },
  { pattern: /(^|\/)\.swcrc/,              name: 'SWC config' },
];

/**
 * Scan the repo tree for build-tool configuration files.
 * Returns the first matching indicator, or null if none found.
 */
function findBuildIndicator(tree) {
  if (!Array.isArray(tree) || tree.length === 0) return null;
  for (const indicator of BUILD_INDICATORS) {
    if (tree.some(path => indicator.pattern.test(path))) {
      return indicator;
    }
  }
  return null;
}

/**
 * Check if a parsed package.json has a recognised build script.
 */
function extractBuildScript(pkg) {
  const scripts = pkg?.scripts || {};
  if (scripts.build)       return scripts.build;
  if (scripts['build:prod']) return scripts['build:prod'];
  if (scripts.compile)     return scripts.compile;
  if (scripts['build:production']) return scripts['build:production'];
  return null;
}

/**
 * Layer 3: Try the GitHub Contents API as a fallback when files.get() fails.
 * This uses a different endpoint (api.github.com) which has separate rate limits
 * from raw.githubusercontent.com.
 */
async function fetchPackageJsonViaApi(owner, repo) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/package.json`,
      { headers: { 'User-Agent': 'mach-speed-platform' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.content && data.encoding === 'base64') {
      const decoded = atob(data.content.replace(/\s/g, ''));
      return JSON.parse(decoded);
    }
    return null;
  } catch {
    return null;
  }
}

export async function check(context) {
  const { packageJson, repoType, files, tree, owner, repo } = context;

  try {
    // ── Empty repos ──────────────────────────────────────────────
    if (repoType === RepoType.EMPTY) {
      return {
        checkId, status: 'not-applicable', confidence: 'high',
        message: 'Empty repo — no build step needed', findings: [],
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER 1: Use package.json from context (fastest, most reliable)
    // ═══════════════════════════════════════════════════════════════
    let pkg = packageJson;

    // ═══════════════════════════════════════════════════════════════
    // LAYER 2: Fallback — read package.json via files API
    // Handles cases where upstream fetch/parse failed.
    // ═══════════════════════════════════════════════════════════════
    if (!pkg && files) {
      const hasPkg = typeof files.has === 'function'
        ? files.has('package.json')
        : Array.isArray(tree) && tree.includes('package.json');

      if (hasPkg && typeof files.get === 'function') {
        try {
          const content = await files.get('package.json');
          if (content) pkg = JSON.parse(content);
        } catch { /* ignore parse / network errors */ }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER 3: Fallback — GitHub Contents API
    // Uses a different rate-limit bucket than raw.githubusercontent.com
    // ═══════════════════════════════════════════════════════════════
    if (!pkg && owner && repo) {
      pkg = await fetchPackageJsonViaApi(owner, repo);
    }

    // ── We have package.json → check scripts ─────────────────────
    if (pkg) {
      const buildScript = extractBuildScript(pkg);

      if (buildScript) {
        return {
          checkId, status: 'pass', confidence: 'high',
          message: `Build script found: "${buildScript}"`, findings: [],
        };
      }

      // Server frameworks (Express, Fastify, etc.) don't need a build step
      // — they're consumed via require/import. Only fail if it's NOT a server.
      if (repoType === RepoType.SERVER) {
        return {
          checkId, status: 'not-applicable', confidence: 'medium',
          message: 'Server app — build step may not be required', findings: [],
        };
      }

      return {
        checkId, status: 'fail', confidence: 'high',
        message: 'No build script found',
        findings: [{ file: 'package.json', issue: 'Missing "build" script' }],
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER 4: Last resort — scan tree for build-tool config files
    // Handles network/rate-limit issues where package.json is unreadable
    // but the GitHub tree API (which has higher rate limits) still works.
    // ═══════════════════════════════════════════════════════════════
    const indicator = findBuildIndicator(tree);
    if (indicator) {
      return {
        checkId, status: 'pass', confidence: 'medium',
        message: `${indicator.name} found — build step likely configured`,
        findings: [],
      };
    }

    // ── Nothing found anywhere ───────────────────────────────────
    return {
      checkId, status: 'check-it', confidence: 'low',
      message: 'No package.json readable and no build indicators found in repo tree',
      findings: [],
    };

  } catch (err) {
    return {
      checkId, status: 'check-it', confidence: 'low',
      message: `Error: ${err.message}`, findings: [],
    };
  }
}
