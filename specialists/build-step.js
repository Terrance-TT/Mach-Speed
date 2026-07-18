import { RepoType } from '../contract.js';

export const checkId = 'build-step';
export const name = 'Build Step Defined';
export const appliesTo = ['all'];

/** Build-tool config files that imply a build step exists.
 *  Stronger signals are listed first; weaker platform-only signals are omitted
 *  to avoid false positives on pure JS runtime libraries.
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

  // TypeScript / transpiler configs
  { pattern: /(^|\/)tsconfig\.json$/,      name: 'TypeScript config' },
  { pattern: /(^|\/)babel\.config\./,      name: 'Babel config' },
  { pattern: /(^|\/)\.babelrc/,            name: 'Babel config' },
  { pattern: /(^|\/)swc\.config\./,        name: 'SWC config' },
  { pattern: /(^|\/)\.swcrc/,              name: 'SWC config' },

  // Modern runtimes & platforms
  { pattern: /(^|\/)deno\.jsonc?$/,        name: 'Deno config' },
  { pattern: /(^|\/)bunfig\.toml$/,        name: 'Bun config' },
  { pattern: /(^|\/)nitro\.config\./,      name: 'Nitro config' },
  { pattern: /(^|\/)wrangler\.(toml|json)$/, name: 'Wrangler config' },
  { pattern: /(^|\/)drizzle\.config\./,    name: 'Drizzle config' },

  // Monorepo build pipelines
  { pattern: /(^|\/)turbo\.json$/,         name: 'Turborepo config' },
  { pattern: /(^|\/)pnpm-workspace\.yaml$/, name: 'PNPM workspace' },
  { pattern: /(^|\/)lerna\.json$/,          name: 'Lerna monorepo' },
  { pattern: /(^|\/)nx\.json$/,             name: 'Nx monorepo' },
  { pattern: /(^|\/)rush\.json$/,           name: 'Rush monorepo' },

  // Container / deployment configs that imply image builds
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
  { pattern: /(^|\/)cloudbuild\.yaml$/,    name: 'Cloud Build config' },
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
 * Check if a parsed package.json scripts object has a recognised build script.
 * Looks at script names and command values.
 */
function findBuildScript(scripts) {
  if (!scripts || typeof scripts !== 'object') return null;

  // Exact high-confidence matches
  const exactKeys = ['build', 'compile', 'build:prod', 'build:production', 'build:main', 'build:fp', 'dist', 'bundle'];
  for (const key of exactKeys) {
    if (scripts[key]) return scripts[key];
  }

  // Name-based partial matches
  const nameTokens = ['build', 'compile', 'dist', 'bundle', 'make'];
  for (const [name, cmd] of Object.entries(scripts)) {
    const lower = name.toLowerCase();
    if (nameTokens.some(t => lower.includes(t))) {
      return cmd;
    }
  }

  // Command-based matches (build tools or explicit build invocations)
  const buildCmdRe = /(?:^|\s)(?:tsc|tsx|vite|webpack|rollup|esbuild|swc|babel|turbo|nx|lerna|rush|make|cmake|gradle|mvn)\b|(?:^|\s)(?:cargo build|go build|dotnet build)|(?:next|nuxt|gatsby|remix|astro)\s+build|(?:npm run|pnpm|yarn)\s+(?:build|compile|dist|bundle)/i;
  for (const [name, cmd] of Object.entries(scripts)) {
    if (buildCmdRe.test(cmd)) {
      return cmd;
    }
  }

  return null;
}

/**
 * Layer 3: Try the GitHub Contents API as a fallback when files.get() fails.
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
  } catch (err) {
    console.error('fetchPackageJsonViaApi failed:', err);
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
    // LAYER 1-3: Resolve root package.json (context → files → API)
    // ═══════════════════════════════════════════════════════════════
    let rootPkg = packageJson;

    if (!rootPkg && files) {
      const hasPkg = typeof files.has === 'function'
        ? files.has('package.json')
        : Array.isArray(tree) && tree.includes('package.json');

      if (hasPkg && typeof files.get === 'function') {
        try {
          const content = await files.get('package.json');
          if (content) rootPkg = JSON.parse(content);
        } catch (err) {
          console.error('Error reading package.json via files API:', err);
        }
      }
    }

    if (!rootPkg && owner && repo) {
      rootPkg = await fetchPackageJsonViaApi(owner, repo);
    }

    // ── Evaluate root scripts ────────────────────────────────────
    let buildScript = null;
    if (rootPkg?.scripts) {
      buildScript = findBuildScript(rootPkg.scripts);
    }

    if (buildScript) {
      return {
        checkId, status: 'pass', confidence: 'high',
        message: `Build script found: "${buildScript}"`, findings: [],
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // Workspace / monorepo package.json scan (bounded reads)
    // Prioritise packages/ and apps/ directories.
    // ═══════════════════════════════════════════════════════════════
    if (!buildScript && Array.isArray(tree) && files?.get) {
      const candidates = tree
        .filter(p => /(^|\/)package\.json$/.test(p) && p !== 'package.json')
        .sort((a, b) => {
          const score = (p) => {
            if (/\bpackages?\//.test(p)) return 1;
            if (/\bapps?\//.test(p)) return 2;
            if (/\bexamples?\//.test(p)) return 3;
            if (/\b(www|web|site|docs)\//.test(p)) return 4;
            return 5;
          };
          return score(a) - score(b);
        })
        .slice(0, 10);

      for (const pkgPath of candidates) {
        try {
          const content = await files.get(pkgPath);
          if (!content) continue;
          const pkg = JSON.parse(content);
          const script = findBuildScript(pkg.scripts || {});
          if (script) {
            return {
              checkId, status: 'pass', confidence: 'high',
              message: `Build script found in workspace (${pkgPath}): "${script}"`, findings: [],
            };
          }
        } catch (err) {
          console.error(`Error reading workspace package ${pkgPath}:`, err);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYER 4: Scan repo tree for build-tool config files
    // ═══════════════════════════════════════════════════════════════
    const indicator = findBuildIndicator(tree);
    if (indicator) {
      return {
        checkId, status: 'pass', confidence: 'medium',
        message: `${indicator.name} found — build step likely configured`,
        findings: [],
      };
    }

    // ── Decide whether a build step is actually required ─────────
    const hasTsConfig = tree?.some(p => /(^|\/)tsconfig\.json$/.test(p));
    const hasTypeScript = tree?.some(p => /\.([cm]?ts|tsx)$/.test(p) && !/\.d\.[cm]?ts$/.test(p));

    if (!hasTsConfig && !hasTypeScript) {
      // Pure JS runtime projects often don't need a build step
      if (['library', 'framework', 'tool', 'server'].includes(repoType)) {
        return {
          checkId, status: 'not-applicable', confidence: 'medium',
          message: 'Pure JS runtime project — no build step required', findings: [],
        };
      }
    }

    if (hasTsConfig || hasTypeScript) {
      return {
        checkId, status: 'fail', confidence: 'high',
        message: 'TypeScript files detected but no build script or build configuration found',
        findings: [{ file: 'package.json', issue: 'Missing build script for TypeScript compilation' }],
      };
    }

    // ── Nothing found anywhere ───────────────────────────────────
    return {
      checkId, status: 'check-it', confidence: 'low',
      message: 'Unable to determine if a build step is needed',
      findings: [],
    };

  } catch (err) {
    console.error('Build-step specialist error:', err);
    return {
      checkId, status: 'check-it', confidence: 'low',
      message: `Error: ${err.message}`, findings: [],
    };
  }
}