export const checkId = 'cors';
export const name = 'CORS Configured';
export const appliesTo = ['deployable', 'server', 'framework'];

const CORS_PATTERNS = [
  /require\s*\(\s*['"][^'"]*cors['"]\s*\)/,
  /import\s+.*?['"][^'"]*cors['"]/,
  /from\s+['"][^'"]*cors['"]/,
  /access-control-allow-origin/i,
  /access-control-allow-methods/i,
  /access-control-allow-headers/i,
  /access-control-allow-credentials/i,
  /access-control-expose-headers/i,
  /access-control-max-age/i,
  /access-control-request/i,
  /cors\s*:\s*(true|\{)/i,
  /cors\s*\(/i,
  /enableCors/i,
  /allowedOrigins?/i,
  /allowOrigin/i,
  /corsOrigins?/i,
  /use\s*\(\s*cors/i,
  /register\s*\([^)]*cors/i,
  /corsHandler/i,
  /handleCors/i,
  /withCors/i,
  /setHeader\s*\(\s*['"]Access-Control/i,
  /headers\s*\(\s*\)\s*\{[^}]*access-control/i,
];

const BACKEND_DEPS = ['express', 'fastify', 'koa', 'hono', 'elysia', 'hapi', 'sails', 'meteor', 'feathers', 'restify', 'polka', 'micro', 'connect', 'restana', '0http', 'nitro', 'h3'];
const CONTENT_FRAMEWORKS = ['next', 'nuxt', 'gatsby', 'astro', 'hexo', 'vuepress', 'vitepress', 'docusaurus', 'eleventy'];

const EXCLUDED_PATH_RX = /(^|\/)(node_modules|\.git|\.next|out|dist|build|coverage|\.tmp|test|tests|__tests__|spec|example|examples|demo|demos|fixtures|fixture|mock|mocks|docs|playground|storybook|e2e|cypress|vitest|jest|benchmark|benchmarks|perf)\//i;

function isTutorial(packageJson) {
  if (!packageJson) return false;
  const text = [
    packageJson.name,
    packageJson.description,
    ...(packageJson.keywords || []),
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(learn|learning|tutorial|tutorials|course|workshop|playground|starter[- ]?kit|boilerplate|template|templates|example|examples|sample|demo|demos|getting[- ]?started|how[- ]?to|guide|guides|walkthrough|training|teach|courseware|cheatsheet|introduction)\b/.test(text);
}

function isLibraryOrFramework(packageJson, tree) {
  if (!packageJson) return false;

  const deps = packageJson.dependencies || {};
  if (BACKEND_DEPS.some(d => deps[d])) return false;

  const keywords = (packageJson.keywords || []).map(k => k.toLowerCase());
  const scripts = packageJson.scripts || {};
  const hasServerScript = !!(scripts.start || scripts.serve || scripts['start:prod'] || scripts.preview || scripts.dev);

  const libKeywords = new Set([
    'library', 'framework', 'middleware', 'plugin', 'toolkit', 'sdk',
    'module', 'util', 'utils', 'tool', 'bundler', 'compiler', 'build-tool',
    'router', 'server', 'client', 'component', 'components', 'ui', 'functional',
    'helper', 'helpers', 'package', 'transform', 'loader', 'preset',
  ]);
  const hasLibKeyword = keywords.some(k => libKeywords.has(k));

  const hasMain = !!(packageJson.main || packageJson.module || packageJson.exports || packageJson.typings || packageJson.types);
  const hasVersion = !!packageJson.version;
  const hasPeerDeps = !!(packageJson.peerDependencies && Object.keys(packageJson.peerDependencies).length > 0);

  const hasPackagesDir = tree.some(p => /^packages\/[^/]+(?:\/|$)/.test(p));
  const hasAppsDir = tree.some(p => /^(apps|services|clients|web|www|site|sites|server|api|studio|dashboard|admin|portal|frontend|backend|workers|edge-functions)\/[^/]+(?:\/|$)/.test(p));
  const hasExamplesDir = tree.some(p => /^examples\/[^/]+(?:\/|$)/.test(p));
  const hasTestDir = tree.some(p => /^(test|tests|__tests__|spec|specs)\/[^/]+(?:\/|$)/.test(p));

  if (packageJson.private === true && hasPackagesDir && !hasAppsDir && !hasServerScript) {
    return true;
  }

  if ((packageJson.workspaces || tree.some(p => /^pnpm-workspace\.yaml$/.test(p))) && !hasServerScript && !hasAppsDir) {
    return true;
  }

  if (hasMain && hasVersion && !hasServerScript && (hasLibKeyword || hasPeerDeps || hasExamplesDir)) {
    return true;
  }

  if (hasExamplesDir && hasTestDir && !hasServerScript && !hasAppsDir) {
    return true;
  }

  return false;
}

function isStaticContentSite(packageJson, tree) {
  if (!packageJson) return false;
  const allDeps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };

  if (BACKEND_DEPS.some(d => allDeps[d])) return false;

  const hasContentFramework = CONTENT_FRAMEWORKS.some(f => allDeps[f]);
  const hasApiRoutes = tree.some(p => /\/(api|apis|rest|graphql|trpc)\/[^/]+\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p) && !/(^|\/)node_modules\//.test(p) && !EXCLUDED_PATH_RX.test(p));
  const hasServerEntry = tree.some(p => /^(src\/)?(server|app|listen|main|worker)\.(js|ts|mjs|cjs|mts|cts)$/.test(p) && !/(^|\/)node_modules\//.test(p));

  if (hasContentFramework && !hasApiRoutes && !hasServerEntry) {
    return true;
  }

  const contentFiles = tree.filter(p => /\.(md|mdx|html|css|scss|sass|less|styl)$/.test(p) && !/(^|\/)node_modules\//.test(p)).length;
  const sourceFiles = tree.filter(p => /\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p) && !/(^|\/)node_modules\//.test(p)).length;

  if (sourceFiles === 0 && contentFiles > 5) return true;
  if (contentFiles > sourceFiles * 4 && !hasApiRoutes && !hasServerEntry) return true;

  return false;
}

function hasServerFootprint(tree, packageJson) {
  if (!tree || tree.length === 0) return false;

  const allDeps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  if (BACKEND_DEPS.some(d => allDeps[d])) return true;

  for (const p of tree) {
    if (/(^|\/)node_modules\//.test(p)) continue;
    if (EXCLUDED_PATH_RX.test(p)) continue;

    if (/\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p)) {
      if (/(^|\/)api\/[^/]+\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)pages\/api\/[^/]+\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)app\/api\/[^/]+\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)src\/(?:pages\/api|app\/api)\/[^/]+\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)routes\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)server\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)controllers\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)handlers\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)endpoints\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) return true;
      if (/(^|\/)middleware\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) return true;

      if (/^(src\/)?(server|app|listen|index|main|worker)\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) {
        return true;
      }
    }

    if (/^(vercel\.json|netlify\.toml|_headers|wrangler\.toml|fly\.toml|render\.yaml|app\.yaml|serverless\.yml)$/.test(p)) return true;
  }

  return false;
}

function isDangerousCorsConfig(content) {
  const proximityPatterns = [
    /(?:origin\s*[:=]\s*['"]?\*['"]?)[\s\S]{0,500}?(?:credentials\s*[:=]\s*true|Access-Control-Allow-Credentials\s*:\s*true)/i,
    /(?:credentials\s*[:=]\s*true|Access-Control-Allow-Credentials\s*:\s*true)[\s\S]{0,500}?(?:origin\s*[:=]\s*['"]?\*['"]?)/i,
    /Access-Control-Allow-Origin\s*:\s*\*[\s\S]{0,500}?Access-Control-Allow-Credentials\s*:\s*true/i,
    /Access-Control-Allow-Credentials\s*:\s*true[\s\S]{0,500}?Access-Control-Allow-Origin\s*:\s*\*/i,
  ];
  if (proximityPatterns.some(r => r.test(content))) return true;

  for (const match of content.matchAll(/cors\s*\(\s*\{/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let idx = start;
    while (idx < content.length && depth > 0) {
      const ch = content[idx];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      idx++;
    }
    if (depth === 0) {
      const block = content.slice(start, idx - 1);
      if (/(?:credentials\s*:\s*true|credentials\s*=\s*true)/i.test(block)) {
        const originMatch = block.match(/origin\s*[:=]\s*([^,\}\n\r]+)/i);
        if (!originMatch) return true;
        const val = originMatch[1].trim();
        if (val === '*' || val === "'*'" || val === '"*"') {
          return true;
        }
      }
    }
  }

  return false;
}

async function scanFilesForCors(tree, files) {
  const candidates = [];

  for (const p of tree) {
    if (/(^|\/)node_modules\//.test(p)) continue;
    if (EXCLUDED_PATH_RX.test(p)) continue;

    let score = 0;

    if (/\.config\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 100;
    if (/^(vercel\.json|netlify\.toml|_headers|wrangler\.toml|fly\.toml|render\.yaml)$/.test(p)) score += 100;

    if (/(^|\/)api\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 80;
    if (/(^|\/)pages\/api\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 80;
    if (/(^|\/)app\/api\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 80;

    if (/^(src\/)?(server|app|listen|index|main|worker)\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 70;
    if (/(^|\/)server\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 60;
    if (/middleware\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 60;
    if (/(^|\/)routes\/[^/]+\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 50;

    if (/\.(js|ts|mjs|cjs|mts|cts)$/.test(p)) score += 10;

    if (score > 0) candidates.push({ path: p, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const { path } of candidates.slice(0, 25)) {
    try {
      const content = await files.get(path);
      if (!content) continue;
      for (const pat of CORS_PATTERNS) {
        if (pat.test(content)) {
          const dangerous = isDangerousCorsConfig(content);
          return { path, dangerous };
        }
      }
    } catch {
      // ignore read errors
    }
  }

  return null;
}

async function scanSubPackagesForCorsDep(tree, files) {
  const subPkgs = tree.filter(p => /(^|\/)package\.json$/.test(p) && !/(^|\/)node_modules\//.test(p));
  for (const pkgPath of subPkgs.slice(0, 15)) {
    if (pkgPath === 'package.json') continue;
    try {
      const content = await files.get(pkgPath);
      if (!content) continue;
      const subPkg = JSON.parse(content);
      const deps = {
        ...(subPkg.dependencies || {}),
        ...(subPkg.devDependencies || {}),
        ...(subPkg.peerDependencies || {}),
      };
      if (deps.cors || deps['@fastify/cors'] || deps['koa-cors'] || deps['@koa/cors']) {
        return pkgPath;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return null;
}

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    if (!tree || tree.length === 0) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Empty repository', findings: [] };
    }

    if (isTutorial(packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Tutorial or example repository — CORS not applicable', findings: [] };
    }

    if (isLibraryOrFramework(packageJson, tree)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library or framework source — CORS not applicable', findings: [] };
    }

    if (isStaticContentSite(packageJson, tree)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Static or content site without API endpoints — CORS not needed', findings: [] };
    }

    if (!hasServerFootprint(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'No server or API endpoints detected — CORS not needed', findings: [] };
    }

    const allDeps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const hasFullstackDep = CONTENT_FRAMEWORKS.some(f => allDeps[f]);
    const hasApiRoutes = tree.some(p => /\/(api|apis|rest|graphql|trpc)\/[^/]+\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/.test(p) && !/(^|\/)node_modules\//.test(p) && !EXCLUDED_PATH_RX.test(p));
    if (hasFullstackDep && !hasApiRoutes) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Fullstack framework site without API routes — CORS not needed', findings: [] };
    }

    const corsResult = await scanFilesForCors(tree, files);
    if (corsResult) {
      if (corsResult.dangerous) {
        return {
          checkId,
          status: 'fail',
          confidence: 'high',
          message: `Dangerous CORS misconfiguration in ${corsResult.path}: wildcard origin with credentials enabled`,
          findings: [{ file: corsResult.path, issue: 'CORS allows wildcard origin with credentials, which is insecure' }],
        };
      }
      return { checkId, status: 'pass', confidence: 'high', message: `CORS configuration found in ${corsResult.path}`, findings: [{ file: corsResult.path, issue: 'CORS detected' }] };
    }

    const rootDeps = {
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
      ...(packageJson?.peerDependencies || {}),
    };
    if (rootDeps.cors || rootDeps['@fastify/cors'] || rootDeps['@koa/cors'] || rootDeps['koa-cors']) {
      return { checkId, status: 'pass', confidence: 'high', message: 'CORS dependency found in package.json', findings: [] };
    }

    const subPkgCors = await scanSubPackagesForCorsDep(tree, files);
    if (subPkgCors) {
      return { checkId, status: 'pass', confidence: 'high', message: `CORS dependency found in ${subPkgCors}`, findings: [{ file: subPkgCors, issue: 'cors dependency detected' }] };
    }

    const hasBackendDep = BACKEND_DEPS.some(d => allDeps[d]);
    if (hasBackendDep) {
      return { checkId, status: 'check-it', confidence: 'medium', message: 'Backend server detected without visible CORS configuration', findings: [{ file: 'unknown', issue: 'Verify CORS is configured for this API service' }] };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: 'Server/API endpoints detected but unable to determine if CORS is required',
      findings: [{ file: 'unknown', issue: 'Server endpoints present; verify if cross-origin requests need CORS configuration' }],
    };
  } catch (err) {
    console.error(`[${checkId}] Unexpected error:`, err);
    return { checkId, status: 'not-applicable', confidence: 'low', message: `Error during CORS check: ${err.message}`, findings: [{ file: 'unknown', issue: `Error: ${err.message}` }] };
  }
}