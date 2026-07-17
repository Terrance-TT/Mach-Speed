// specialists/env-vars.js — Checks if sensitive configuration uses environment variables

import { RepoType } from '../contract.js';

export const checkId = 'env-vars';
export const name = 'Environment Variables';
export const appliesTo = ['all'];

// ── File prioritization ──────────────────────────────────────
function scoreFile(path) {
  const base = path.split('/').pop().toLowerCase();
  let score = 0;

  const entryNames = ['index', 'main', 'server', 'app', 'config', 'entry', 'start', 'cli', 'build', 'core', 'runtime', 'compiler'];
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

// ── Test/example file detection ────────────────────────────────
function isTestOrExampleFile(path) {
  if (/(^|\/)test(s|ing)?\//.test(path)) return true;
  if (/(^|\/)__tests__?\//.test(path)) return true;
  if (/(^|\/)spec(s|ification)?\//.test(path)) return true;
  if (/(^|\/)__mocks__\//.test(path)) return true;
  if (/(^|\/)__fixtures__\//.test(path)) return true;
  if (/(^|\/)e2e\//.test(path)) return true;
  if (/(^|\/)integration\//.test(path)) return true;
  if (/(^|\/)benchmark(s)?\//.test(path)) return true;
  if (/(^|\/)examples?\//.test(path) && !/\.env(\.|$)/.test(path)) return true;
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

// ── Scan files for env usage ───────────────────────────────────
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
    } catch (e) {
      // continue scanning other files
    }
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
    const scripts = packageJson?.scripts || {};
    const scriptsStr = JSON.stringify(scripts);
    const hasWorkspaces = !!packageJson?.workspaces;

    const isNodeModules = p => p.includes('node_modules');

    // ── Tree-based signals (fast, no reads) ─────────────────────
    const hasAnyEnvFile = tree.some(p => /\.env(\..+)?$/.test(p) && !isNodeModules(p));
    const hasDotenvDep = !!(deps.dotenv || deps['@dotenvx/dotenvx'] || deps['dotenv-expand'] || devDeps.dotenv);
    const hasDockerfile = tree.some(p => (p === 'Dockerfile' || p === 'docker-compose.yml' || p === 'docker-compose.yaml') && !isNodeModules(p));
    const hasTurboJson = tree.some(p => p.endsWith('turbo.json') && !isNodeModules(p));
    const hasWrangler = tree.some(p => /wrangler\.(toml|json)$/.test(p) && !isNodeModules(p));
    const hasVercelJson = tree.some(p => p === 'vercel.json' && !isNodeModules(p));
    const hasNetlifyToml = tree.some(p => p === 'netlify.toml' && !isNodeModules(p));
    const hasFlyToml = tree.some(p => /fly\.toml$/.test(p) && !isNodeModules(p));
    const hasServerlessConfig = tree.some(p => /serverless\.(yml|yaml|json)$/.test(p) && !isNodeModules(p));
    const hasPnpmWorkspace = tree.some(p => p === 'pnpm-workspace.yaml' && !isNodeModules(p));
    const hasNxJson = tree.some(p => p === 'nx.json' && !isNodeModules(p));
    const hasLernaJson = tree.some(p => p === 'lerna.json' && !isNodeModules(p));

    const hasFrameworkConfig = tree.some(p =>
      !isNodeModules(p) &&
      /(next|nuxt|astro|remix|svelte|gatsby|eleventy|nitro)\.config\./.test(p)
    );
    const hasOrmConfig = tree.some(p =>
      !isNodeModules(p) &&
      /(drizzle|prisma|knexfile|sequelize)\.config\./.test(p)
    );
    const hasBuildConfig = tree.some(p =>
      !isNodeModules(p) &&
      /(webpack|rspack|rollup|vite|esbuild|tsup|parcel|farm)\.config\./.test(p)
    );

    const subPackageJsons = tree.filter(p => p.endsWith('package.json') && p !== 'package.json' && !isNodeModules(p));
    const hasSubPackages = subPackageJsons.length > 0;

    const hasEnvInScripts = /\b(?:NODE_ENV|cross-env|dotenvx|dotenv|env-cmd)\b|\benv\./.test(scriptsStr);
    const scriptKeys = Object.keys(scripts);
    const hasStartScript = scriptKeys.some(k => ['start', 'dev', 'serve'].includes(k));
    const hasDeployScript = scriptKeys.some(k => k.startsWith('deploy')) || !!scripts.preview;

    const buildToolDeps = ['webpack', 'rollup', 'vite', 'esbuild', 'parcel', 'rspack', 'next', 'nuxt', 'remix', 'astro', 'gatsby', 'sveltekit', 'babel', 'typescript', 'tsup', 'unbuild', 'turbo', 'vitest'];
    const hasBuildTool = buildToolDeps.some(t => !!deps[t] || !!devDeps[t]);

    const sourceFileCount = tree.filter(p => /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p) && !isNodeModules(p) && !/\.d\.ts$/.test(p)).length;

    // ── Build bounded scan list (config files + JS sources) ─────
    const configFilesToScan = tree
      .filter(p => {
        if (isNodeModules(p)) return false;
        if (p.endsWith('turbo.json')) return true;
        if (/wrangler\.(toml|json)$/.test(p)) return true;
        if (p === 'package.json') return true;
        if (p.endsWith('package.json') && /\/(apps|packages|examples|www|docs|site|web|services|api)\//.test(p)) return true;
        return false;
      })
      .sort((a, b) => a.split('/').length - b.split('/').length)
      .slice(0, 10);

    const jsFiles = buildFileList(tree, 20);
    const filesToScan = [...new Set([...configFilesToScan, ...jsFiles])].slice(0, 30);

    const { foundPattern, foundDotenvSetup } = await scanFiles(filesToScan, files);

    // 1. Direct code evidence → high confidence pass
    if (foundPattern) {
      const parts = [];
      if (hasDotenvDep || foundDotenvSetup) parts.push('dotenv configured');
      if (hasAnyEnvFile) parts.push('.env file present');
      const runtimeInfo = parts.join(', ') || `${foundPattern} usage found`;
      return { checkId, status: 'pass', confidence: 'high', message: `Uses environment variables (${runtimeInfo})`, findings: [] };
    }

    // 2. Read turbo.json for explicit env declarations
    if (hasTurboJson) {
      const turboPath = tree.find(p => p.endsWith('turbo.json') && !isNodeModules(p));
      if (turboPath) {
        try {
          const turboContent = await files.get(turboPath);
          if (turboContent && /"globalEnv"|"env"\s*:/.test(turboContent)) {
            return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (turborepo env config)', findings: [] };
          }
        } catch (e) { /* ignore */ }
      }
    }

    // 3. Read sub-package.jsons for env references in scripts
    if (hasSubPackages) {
      const pkgsToRead = subPackageJsons.slice(0, 5);
      for (const pkgPath of pkgsToRead) {
        try {
          const pkgContent = await files.get(pkgPath);
          if (pkgContent && /\b(?:NODE_ENV|cross-env|dotenvx|dotenv|env-cmd)\b|\benv\./.test(pkgContent)) {
            return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (env referenced in workspace package)', findings: [] };
          }
        } catch (e) { /* ignore */ }
      }
    }

    // 4. Strong single-signal passes
    if (hasAnyEnvFile) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (.env file present)', findings: [] };
    }
    if (hasDotenvDep) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (dotenv dependency)', findings: [] };
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
    if (hasEnvInScripts) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Uses environment variables (env referenced in scripts)', findings: [] };
    }

    // 5. Compose weaker signals
    const signals = [];
    if (hasFrameworkConfig) signals.push('framework config');
    if (hasBuildConfig) signals.push('build config');
    if (hasTurboJson) signals.push('turborepo config');
    if (hasVercelJson || hasNetlifyToml || hasFlyToml || hasServerlessConfig) signals.push('deployment config');
    if (hasSubPackages) signals.push('monorepo structure');
    if (hasWorkspaces || hasPnpmWorkspace || hasNxJson || hasLernaJson) signals.push('workspace config');
    if (hasStartScript) signals.push('start script');
    if (hasBuildTool) signals.push('build tool dependency');

    // 6. Multi-signal pass
    if (signals.length >= 2) {
      return { checkId, status: 'pass', confidence: 'medium', message: `Uses environment variables (${signals.join(', ')})`, findings: [] };
    }

    // 7. Type-based decisive inference
    if (repoType === RepoType.FRAMEWORK) {
      if (signals.length > 0 || hasBuildTool || hasFrameworkConfig || sourceFileCount > 30) {
        const reason = signals.length ? signals.join(', ') : (hasFrameworkConfig ? 'framework config' : 'substantial framework codebase');
        return { checkId, status: 'pass', confidence: 'medium', message: `Uses environment variables (${reason})`, findings: [] };
      }
    }

    if (repoType === RepoType.DEPLOYABLE || repoType === RepoType.SERVER) {
      if (signals.length > 0 || hasStartScript || hasDockerfile || hasSubPackages) {
        const reason = signals.length ? signals.join(', ') : 'deployment signals present';
        return { checkId, status: 'pass', confidence: 'medium', message: `Uses environment variables (${reason})`, findings: [] };
      }
    }

    // 8. Library exception
    if (repoType === RepoType.LIBRARY) {
      return { checkId, status: 'not-applicable', confidence: 'medium', message: 'Library — env var usage not required', findings: [] };
    }

    // 9. Single weak signal → low confidence pass (decisive over check-it)
    if (signals.length === 1) {
      return { checkId, status: 'pass', confidence: 'low', message: `Uses environment variables (${signals[0]})`, findings: [] };
    }

    // 10. Genuinely ambiguous
    return { checkId, status: 'check-it', confidence: 'medium', message: 'No environment variable usage detected', findings: [] };

  } catch (err) {
    console.error(err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [] };
  }
}