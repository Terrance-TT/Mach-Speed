// specialists/env-vars.js — Checks if sensitive configuration uses environment variables

import { RepoType } from '../contract.js';

export const checkId = 'env-vars';
export const name = 'Environment Variables';
export const appliesTo = ['all'];

// ── File prioritization ──────────────────────────────────────
// Score source files so entry-point / config files are scanned first.
function scoreFile(path) {
  const base = path.split('/').pop().toLowerCase();
  let score = 0;

  // Named entry points / config files
  const entryNames = ['index', 'main', 'server', 'app', 'config', 'entry', 'start', 'cli'];
  if (entryNames.some(n => base.includes(n))) score += 5;

  // Build-tool configs — very likely to contain process.env.NODE_ENV
  const buildConfigs = [
    'webpack.config', 'rollup.config', 'vite.config', 'babel.config',
    '.babelrc', 'tsup.config', 'esbuild.config', 'next.config',
    'nuxt.config', 'astro.config', 'vue.config', 'svelte.config',
    'remix.config', 'gatsby.config', 'eleventy.config', 'parcel.config',
    'rspack.config', 'farm.config', 'turbo.config', 'unbuild.config',
  ];
  if (buildConfigs.some(n => base.includes(n))) score += 4;

  // Root-level files are often entry points
  if (!path.includes('/')) score += 2;

  // Source directories
  if (/^(src|lib|app|bin|server|api)\//.test(path)) score += 1;

  return score;
}

// ── Test/example file detection ────────────────────────────────
function isTestOrExampleFile(path) {
  // Test / mock / fixture / benchmark directories
  if (/(^|\/)test(s|ing)?\//.test(path)) return true;
  if (/(^|\/)__tests__?\//.test(path)) return true;
  if (/(^|\/)spec(s|ification)?\//.test(path)) return true;
  if (/(^|\/)__mocks__\//.test(path)) return true;
  if (/(^|\/)__fixtures__\//.test(path)) return true;
  if (/(^|\/)e2e\//.test(path)) return true;
  if (/(^|\/)integration\//.test(path)) return true;
  if (/(^|\/)benchmark(s)?\//.test(path)) return true;
  // Example directories
  if (/(^|\/)examples?\//.test(path)) return true;
  // Test-config files
  const base = path.split('/').pop();
  if (/^(jest|vitest|karma|playwright|cypress)\.config\./.test(base)) return true;
  // Test file extensions
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
  { regex: /process\.env\./g, name: 'process.env' },
  { regex: /import\.meta\.env/g, name: 'import.meta.env' },
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

// ── Scan a list of files for env usage ─────────────────────────
async function scanFiles(fileList, files) {
  let foundPattern = null;
  let foundDotenvSetup = false;
  for (const filePath of fileList) {
    const content = await files.get(filePath);
    if (!content) continue;
    const pattern = findEnvUsage(content);
    if (pattern && !foundPattern) foundPattern = pattern;
    if (/require\(['"]dotenv['"]\)/.test(content) || /import.*dotenv/.test(content) || /dotenv\.config/.test(content)) {
      foundDotenvSetup = true;
    }
    if (foundPattern) break; // stop once we find env usage
  }
  return { foundPattern, foundDotenvSetup };
}

// ── Build the prioritized file list ────────────────────────────
function buildFileList(tree, scanLimit) {
  return tree
    .filter(p =>
      /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p) &&
      !/\.d\.ts$/.test(p) &&
      !isTestOrExampleFile(p)
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
    const scriptsStr = JSON.stringify(packageJson?.scripts || {});

    // ── Layer 1: Signal detection (no file reads, fast) ──────────
    const hasDotenvDep = !!(deps.dotenv || deps['@dotenvx/dotenvx'] || deps['dotenv-expand'] || devDeps.dotenv);
    const hasEnvFile = tree.some(p => p === '.env' || p.startsWith('.env.'));
    const hasEnvInScripts = /NODE_ENV|cross-env|dotenvx|env\./.test(scriptsStr);
    const hasBuildTool = [
      'webpack', 'rollup', 'vite', 'esbuild', 'parcel', 'rspack',
      'next', 'nuxt', 'remix', 'astro', 'gatsby', 'sveltekit',
      'babel', 'typescript', 'tsup', 'unbuild', 'turbo',
    ].some(t => !!deps[t] || !!devDeps[t]);

    const signals = [];
    if (hasDotenvDep) signals.push('dotenv dependency');
    if (hasEnvFile) signals.push('.env file present');
    if (hasEnvInScripts) signals.push('env referenced in scripts');
    if (hasBuildTool) signals.push('build tool detected');

    // ── Layer 2: Scanned file detection (up to 10 or 15 files) ────
    const scanLimit = (signals.length >= 2) ? 15 : 10;
    const sourceFiles = buildFileList(tree, scanLimit);
    const { foundPattern, foundDotenvSetup } = await scanFiles(sourceFiles, files);

    if (foundPattern) {
      const parts = [];
      if (hasDotenvDep || foundDotenvSetup) parts.push('dotenv configured');
      if (hasEnvFile) parts.push('.env file present');
      const runtimeInfo = parts.join(', ') || `${foundPattern} usage found`;
      return { checkId, status: 'pass', confidence: 'high', message: `Uses environment variables (${runtimeInfo})`, findings: [] };
    }

    // ── Layer 3: Signal-based inference ──────────────────────────
    // Strong signals mean env vars are very likely used even if we didn't
    // find them in the top-N scanned files (large repos, env usage in
    // unscored files, build-time only references, etc.)
    if (signals.length >= 2) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: `Uses environment variables (${signals.join(', ')})`,
        findings: [],
      };
    }

    if (hasEnvFile || hasDotenvDep) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: `Uses environment variables (${signals.join(', ') || 'env tooling present'})`,
        findings: [],
      };
    }

    // ── Layer 4: Library exception ───────────────────────────────
    if (repoType === RepoType.LIBRARY) {
      return { checkId, status: 'not-applicable', confidence: 'medium', message: 'UI library — env var usage not required', findings: [] };
    }

    return { checkId, status: 'check-it', confidence: 'medium', message: 'No environment variable usage detected', findings: [] };

  } catch (err) {
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [] };
  }
}
