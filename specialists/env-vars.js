// specialists/env-vars.js — Checks if sensitive configuration uses environment variables

import { RepoType } from '../contract.js';

export const checkId = 'env-vars';
export const name = 'Environment Variables';
export const appliesTo = ['all'];

// ── File prioritization ──────────────────────────────────────
function scoreFile(path) {
  const base = path.split('/').pop().toLowerCase();
  let score = 0;

  const entryNames = ['index', 'main', 'server', 'app', 'config', 'entry', 'start', 'cli', 'bin', 'build', 'core', 'runtime', 'compiler'];
  if (entryNames.some(n => base.includes(n))) score += 5;

  const buildConfigs = [
    'webpack.config', 'rollup.config', 'vite.config', 'babel.config',
    '.babelrc', 'tsup.config', 'esbuild.config', 'next.config',
    'nuxt.config', 'astro.config', 'vue.config', 'svelte.config',
    'remix.config', 'gatsby.config', 'eleventy.config', 'parcel.config',
    'rspack.config', 'farm.config', 'turbo.config', 'unbuild.config',
  ];
  if (buildConfigs.some(n => base.includes(n))) score += 4;

  if (!path.includes('/')) score += 2;
  if (/^(src|lib|app|bin|server|api|packages|apps)\//.test(path)) score += 1;

  return score;
}

// ── Test file detection (examples are kept; they may be the product) ──
function isTestFile(path) {
  if (/(^|\/)test(s|ing)?\//.test(path)) return true;
  if (/(^|\/)__tests__?\//.test(path)) return true;
  if (/(^|\/)spec(s|ification)?\//.test(path)) return true;
  if (/(^|\/)__mocks__\//.test(path)) return true;
  if (/(^|\/)__fixtures__\//.test(path)) return true;
  if (/(^|\/)e2e\//.test(path)) return true;
  if (/(^|\/)integration\//.test(path)) return true;
  if (/(^|\/)benchmark(s)?\//.test(path)) return true;
  const base = path.split('/').pop();
  if (/^(jest|vitest|karma|playwright|cypress)\.config\./.test(base)) return true;
  if (/\.(test|spec|e2e)\.(js|ts|jsx|tsx|mjs|cjs)$/.test(path)) return true;
  return false;
}

// ── String-literal guard ───────────────────────────────────────
function isInsideString(line, matchIndex) {
  let inSingle = false, inDouble = false, inBacktick = false;
  for (let i = 0; i < matchIndex; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'"  && !inDouble && !inBacktick) inSingle = !inSingle;
    if (ch === '"'  && !inSingle && !inBacktick) inDouble = !inDouble;
    if (ch === '`'  && !inSingle && !inDouble)   inBacktick = !inBacktick;
  }
  return inSingle || inDouble || inBacktick;
}

// ── Detect env usage in source content ─────────────────────────
const ENV_PATTERNS = [
  { regex: /process\.env\b/g, name: 'process.env' },
  { regex: /import\.meta\.env\b/g, name: 'import.meta.env' },
  { regex: /Deno\.env\b/g, name: 'Deno.env' },
  { regex: /Bun\.env\b/g, name: 'Bun.env' },
];

function findEnvUsage(content) {
  const lines = content.split('\n');
  for (const line of lines) {
    for (const pattern of ENV_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, 'g');
      let match;
      while ((match = regex.exec(line)) !== null) {
        if (!isInsideString(line, match.index)) {
          return pattern.name;
        }
      }
    }
  }
  return null;
}

// ── Scan JS/TS files for env usage ─────────────────────────────
async function scanFiles(fileList, files) {
  let foundPattern = null;
  let foundDotenvSetup = false;
  for (const filePath of fileList) {
    try {
      const content = await files.get(filePath);
      if (!content) continue;
      const pattern = findEnvUsage(content);
      if (pattern && !foundPattern) foundPattern = pattern;
      if (/require\(['"]dotenv['"]\)/.test(content) || /import.*dotenv/.test(content) || /dotenv\.config/.test(content)) {
        foundDotenvSetup = true;
      }
      if (foundPattern) break;
    } catch (e) { /* swallow per-file read errors */ }
  }
  return { foundPattern, foundDotenvSetup };
}

// ── Build prioritized file list ────────────────────────────────
function buildFileList(tree, scanLimit) {
  return tree
    .filter(p =>
      !p.includes('node_modules') &&
      /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p) &&
      !/\.d\.ts$/.test(p) &&
      !isTestFile(p)
    )
    .sort((a, b) => scoreFile(b) - scoreFile(a))
    .slice(0, scanLimit);
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    if (repoType === RepoType.EMPTY) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Empty repo — no env vars needed', findings: [] };
    }

    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies } || {};
    const devDeps = packageJson?.devDependencies || {};
    const scripts = packageJson?.scripts || {};
    const scriptsStr = JSON.stringify(scripts);

    // ── Tree-level signals (fast, zero reads) ───────────────────
    const hasEnvFile = tree.some(p => /(^|\/)\.env(\.|$)/.test(p) && !p.includes('node_modules'));
    const hasDotenvDep = !!(deps.dotenv || deps['@dotenvx/dotenvx'] || deps['dotenv-expand'] || devDeps.dotenv);
    const hasEnvInScripts = /\b(?:NODE_ENV|cross-env|dotenvx|dotenv|env-cmd)\b/.test(scriptsStr);
    const hasBuildTool = ['webpack', 'rollup', 'vite', 'esbuild', 'parcel', 'rspack', 'next', 'nuxt', 'remix', 'astro', 'gatsby', 'sveltekit', 'babel', 'typescript', 'tsup', 'unbuild', 'turbo'].some(t => !!deps[t] || !!devDeps[t]);
    const hasTurboJson = tree.some(p => p.endsWith('turbo.json') && !p.includes('node_modules'));
    const hasWrangler = tree.some(p => /wrangler\.(toml|json)$/.test(p) && !p.includes('node_modules'));
    const hasDockerfile = tree.some(p => /(^|\/)Dockerfile$/.test(p) || /(^|\/)docker-compose\.ya?ml$/.test(p));
    const hasVercelJson = tree.some(p => p === 'vercel.json' && !p.includes('node_modules'));
    const hasNetlifyToml = tree.some(p => p === 'netlify.toml' && !p.includes('node_modules'));
    const hasFlyToml = tree.some(p => /fly\.toml$/.test(p) && !p.includes('node_modules'));
    const hasServerlessConfig = tree.some(p => /serverless\.(yml|yaml|json)$/.test(p) && !p.includes('node_modules'));
    const hasFrameworkConfig = tree.some(p => !p.includes('node_modules') && /(next|nuxt|astro|remix|svelte|gatsby|eleventy|nitro)\.config\./.test(p));
    const hasOrmConfig = tree.some(p => !p.includes('node_modules') && /(drizzle|prisma|knexfile|sequelize)\.config\./.test(p));
    const hasPnpmWorkspace = tree.some(p => p === 'pnpm-workspace.yaml' && !p.includes('node_modules'));
    const hasWorkspaces = !!packageJson?.workspaces || hasPnpmWorkspace;
    const subPackages = tree.filter(p => p.endsWith('package.json') && p !== 'package.json' && !p.includes('node_modules'));
    const hasSubPackages = subPackages.length > 0;
    const hasStartScript = ['start', 'dev', 'serve'].some(k => !!scripts[k]);
    const hasDeployScript = ['deploy', 'preview'].some(k => !!scripts[k]) || !!scripts['deploy'];

    const sourceFileCount = tree.filter(p => /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p) && !p.includes('node_modules') && !/\.d\.ts$/.test(p)).length;

    // ── Layer 1: source-code scan ───────────────────────────────
    const scanLimit = (hasWorkspaces || hasSubPackages) ? 40 : 30;
    const sourceFiles = buildFileList(tree, scanLimit);
    const { foundPattern, foundDotenvSetup } = await scanFiles(sourceFiles, files);

    if (foundPattern) {
      const parts = [];
      if (hasDotenvDep || foundDotenvSetup) parts.push('dotenv configured');
      if (hasEnvFile) parts.push('.env file present');
      const info = parts.join(', ') || `${foundPattern} usage found`;
      return { checkId, status: 'pass', confidence: 'high', message: `Uses environment variables (${info})`, findings: [] };
    }

    // ── Layer 2: read turbo.json for explicit env declarations ──
    if (hasTurboJson) {
      const turboPath = tree.find(p => p.endsWith('turbo.json') && !p.includes('node_modules'));
      if (turboPath) {
        try {
          const content = await files.get(turboPath);
          if (content && /"globalEnv"|"env"\s*:/.test(content)) {
            return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (turborepo env config)', findings: [] };
          }
        } catch (e) { /* ignore */ }
      }
    }

    // ── Layer 3: inspect workspace package.json files for env signals ──
    if (hasSubPackages) {
      for (const pkgPath of subPackages.slice(0, 5)) {
        try {
          const content = await files.get(pkgPath);
          if (content && /\b(?:NODE_ENV|cross-env|dotenvx|dotenv|env-cmd|process\.env)\b/.test(content)) {
            return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (workspace package env usage)', findings: [] };
          }
        } catch (e) { /* ignore */ }
      }
    }

    // ── Layer 4: strong standalone signals ──────────────────────
    if (hasEnvFile) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (.env file present)', findings: [] };
    }
    if (hasDotenvDep) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (dotenv dependency)', findings: [] };
    }
    if (hasEnvInScripts) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (env referenced in scripts)', findings: [] };
    }
    if (hasWrangler) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (wrangler config present)', findings: [] };
    }
    if (hasDockerfile) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (container config present)', findings: [] };
    }
    if (hasOrmConfig) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (ORM config present)', findings: [] };
    }
    if (hasDeployScript) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (deploy script present)', findings: [] };
    }

    // ── Layer 5: composed weaker signals ────────────────────────
    const signals = [];
    if (hasBuildTool) signals.push('build tool');
    if (hasFrameworkConfig) signals.push('framework config');
    if (hasTurboJson) signals.push('turborepo');
    if (hasVercelJson || hasNetlifyToml || hasFlyToml || hasServerlessConfig) signals.push('deployment config');
    if (hasWorkspaces || hasSubPackages) signals.push('monorepo');
    if (hasStartScript) signals.push('start script');

    if (signals.length >= 2) {
      return { checkId, status: 'pass', confidence: 'medium', message: `Uses environment variables (${signals.join(', ')})`, findings: [] };
    }

    // ── Layer 6: type-based inference ───────────────────────────
    if (repoType === RepoType.FRAMEWORK || repoType === RepoType.TOOL) {
      if (signals.length > 0 || hasBuildTool || sourceFileCount > 30) {
        const reason = signals.length ? signals.join(', ') : 'framework/tool codebase';
        return { checkId, status: 'pass', confidence: 'medium', message: `Uses environment variables (${reason})`, findings: [] };
      }
    }

    if (repoType === RepoType.DEPLOYABLE || repoType === RepoType.SERVER) {
      if (signals.length > 0 || hasStartScript || hasDockerfile) {
        const reason = signals.length ? signals.join(', ') : 'deployment signals present';
        return { checkId, status: 'pass', confidence: 'medium', message: `Uses environment variables (${reason})`, findings: [] };
      }
    }

    // ── Layer 7: library exception ──────────────────────────────
    if (repoType === RepoType.LIBRARY) {
      return { checkId, status: 'not-applicable', confidence: 'medium', message: 'Library — env var usage not required', findings: [] };
    }

    // ── Layer 8: single weak signal (decisive over check-it) ────
    if (signals.length === 1) {
      return { checkId, status: 'pass', confidence: 'low', message: `Uses environment variables (${signals[0]})`, findings: [] };
    }

    // ── Layer 9: genuinely undecidable ──────────────────────────
    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'No environment variable usage detected',
      findings: [{ file: 'N/A', issue: 'No env var signals found in code, configs, or package metadata' }],
    };

  } catch (err) {
    console.error(err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [{ file: 'N/A', issue: err.message }] };
  }
}