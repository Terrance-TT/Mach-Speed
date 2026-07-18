import { RepoType } from '../contract.js';

export const checkId = 'health-check';
export const name = 'Health Check Route';
export const appliesTo = ['deployable', 'server', 'framework'];

const HEALTH_LIBS = new Set([
  'lightship', 'terminus', 'express-actuator', 'under-pressure',
  '@nestjs/terminus', 'healthcheck-middleware', 'koa-healthcheck',
  'server-health', 'health-check', 'healthcheck', 'node-health-check',
]);

const SERVER_DEPS = new Set([
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'micro', 'restify',
  'connect', 'polka', 'ws', 'socket.io', 'nitropack', 'nitro', 'h3',
  'hono', 'elysia', 'uwebsockets', '@nestjs/core', '@nestjs/common',
  'http-server', 'serve-static',
]);

const MANAGED_FRAMEWORKS = [
  'next', 'nuxt', 'astro', 'gatsby', 'vuepress',
  'docusaurus', '@docusaurus/core', 'hexo', '@11ty/eleventy', 'eleventy',
  'nextra', 'nextra-theme-docs', 'nextra-theme-blog',
];

const EXCLUDED_PATH_RE = /(\/|^)(test|tests|__tests__|__mocks__|fixtures?|examples?|example|demo|demos|playground|benchmark|benchmarks|docs?|\.github|\.storybook|scripts?|tools?|dist|build|coverage|storybook|bin|cli|config|vitest|jest|knip|lint|\.vscode|node_modules)(\/|$)/i;

function isExcludedPath(p) {
  return EXCLUDED_PATH_RE.test(p);
}

function getAllDeps(packageJson) {
  return {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
    ...packageJson?.peerDependencies,
    ...packageJson?.optionalDependencies,
  };
}

function hasProductionStartScript(packageJson) {
  if (!packageJson?.scripts) return false;
  const devIndicators = /\b(nodemon|ts-node-dev|tsx|vite\s+dev|next\s+dev|astro\s+dev|remix\s+dev|webpack-dev-server|concurrently|lerna|nx|react-scripts\s+start|vue-cli-service\s+serve|ng\s+serve)\b/i;

  for (const [name, cmd] of Object.entries(packageJson.scripts)) {
    if (name !== 'start' && !/^start:/i.test(name)) continue;
    if (!cmd || typeof cmd !== 'string') continue;
    if (/\b(dev|docs?|test|spec|__tests__|example|demo|playground|benchmark|build|watch|lint|typecheck|clean|format|ci|release|publish|prepare|prebuild|postbuild)\b/i.test(cmd)) continue;
    if (devIndicators.test(cmd)) continue;
    return true;
  }
  return false;
}

function hasHealthDependency(packageJson) {
  if (!packageJson) return null;
  const deps = getAllDeps(packageJson);
  return Object.keys(deps).find(d => HEALTH_LIBS.has(d)) || null;
}

function healthScriptName(packageJson) {
  if (!packageJson?.scripts) return null;
  for (const name of Object.keys(packageJson.scripts)) {
    if (/^(health|healthcheck|health-check|status|ping|ready|readiness|alive|liveness)(:|$)/i.test(name)) return name;
  }
  return null;
}

function hasDeploymentConfig(tree) {
  return tree.some(p => {
    if (isExcludedPath(p)) return false;
    const l = p.toLowerCase();
    return l === 'dockerfile' || l.startsWith('dockerfile.') ||
      /(^|\/)docker-compose\.(yml|yaml)$/i.test(p) ||
      /(^|\/)fly\.toml$/i.test(p) ||
      /(^|\/)render\.yaml$/i.test(p) ||
      /(^|\/)captain-definition$/i.test(p) ||
      /(^|\/)Procfile$/i.test(p) ||
      /(^|\/)ecosystem\.config\.(js|ts|json|yaml|yml)$/i.test(p) ||
      /(^|\/)k8s\//i.test(p) ||
      /(^|\/)kubernetes\//i.test(p) ||
      /(^|\/)helm\//i.test(p) ||
      /(^|\/)app\.yaml$/i.test(p);
  });
}

function isLibraryPackage(packageJson, tree) {
  if (!packageJson) return false;
  const hasMain = !!(packageJson.main || packageJson.module || packageJson.exports);
  if (!hasMain) return false;
  if (hasDeploymentConfig(tree)) return false;
  if (hasProductionStartScript(packageJson)) return false;

  const prodDeps = packageJson.dependencies || {};
  if (Object.keys(prodDeps).some(d => SERVER_DEPS.has(d))) return false;

  let score = 0;
  if (packageJson.browser) score += 2;
  if (packageJson.types || packageJson.typings) score += 2;
  if (packageJson.exports && typeof packageJson.exports === 'object') score += 1;
  if (packageJson.module) score += 1;
  if (!packageJson.private) score += 1;
  if (packageJson.files) score += 1;

  return score >= 2;
}

function isFrameworkSource(tree, packageJson) {
  const pkgPaths = tree.filter(p => /^packages\/[^/]+\/package\.json$/i.test(p) && !isExcludedPath(p));
  const hasApps = tree.some(p => /^(apps|services|workers)\/[^/]+\/package\.json$/i.test(p) && !isExcludedPath(p));

  if (pkgPaths.length >= 3 && !hasApps && !hasProductionStartScript(packageJson)) return true;
  if (packageJson?.private && (packageJson?.workspaces || tree.some(p => /^pnpm-workspace\.yaml$/i.test(p)))) {
    if (pkgPaths.length >= 2 && !hasApps && !hasProductionStartScript(packageJson)) return true;
  }

  const hasLibEntry = !!(packageJson?.main || packageJson?.module || packageJson?.exports || packageJson?.browser || packageJson?.types);
  if (hasLibEntry && !hasProductionStartScript(packageJson) && !hasApps) {
    const hasServerCode = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !isExcludedPath(p));
    const hasApiDir = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !isExcludedPath(p));
    if (!hasServerCode && !hasApiDir) return true;
  }

  return false;
}

function isBuildTool(packageJson) {
  if (!packageJson) return false;
  if (packageJson.bin || packageJson.directories?.bin) return true;
  const text = `${packageJson.name || ''} ${(packageJson.keywords || []).join(' ')}`.toLowerCase();
  return /\b(monorepo|build[- ]?tool|bundler|compiler|task[- ]?runner|orchestrator|cli[- ]?tool|scaffold|generator)\b/.test(text);
}

function isTutorialRepo(tree, packageJson) {
  const text = `${packageJson?.name || ''} ${packageJson?.description || ''}`.toLowerCase();
  if (/\b(learn|tutorial|course|how[- ]?to|playground|starter[- ]?template|getting[- ]?started|training|workshop|bootcamp|walkthrough)\b/.test(text)) return true;

  const tutorialish = new Set([
    'examples', 'example', 'starters', 'starter', 'templates', 'template',
    'demos', 'demo', 'playground', 'learn', 'learning', 'chapters', 'lessons',
    'tutorial', 'tutorials', 'course', 'workshop', 'workshops', 'exercises',
    'solutions', 'sample', 'samples', 'basics', 'advanced', 'intermediate',
    'beginner', 'steps', 'step-1', 'step-2', 'part-1', 'part-2', 'final',
    'completed', 'answers', 'walkthrough', 'guides', 'guide', 'how-to',
    'howto', 'recipes', 'getting-started',
  ]);

  const seenDirs = new Set();
  let dirsWithTutorialName = 0;
  for (const p of tree) {
    if (isExcludedPath(p)) continue;
    const parts = p.split('/');
    for (let i = 0; i < Math.min(parts.length - 1, 2); i++) {
      const dir = parts[i].toLowerCase();
      if (tutorialish.has(dir) && !seenDirs.has(dir)) {
        seenDirs.add(dir);
        dirsWithTutorialName++;
      }
    }
  }
  if (dirsWithTutorialName >= 2) return true;

  let tutorialPathCount = 0;
  for (const p of tree) {
    if (isExcludedPath(p)) continue;
    if (p.split('/').some(part => tutorialish.has(part.toLowerCase()))) {
      tutorialPathCount++;
    }
  }
  if (tutorialPathCount >= 15) return true;

  return false;
}

function isPlatformManagedFramework(tree, packageJson) {
  if (!packageJson) return false;
  if (hasDeploymentConfig(tree)) return false;

  const deps = getAllDeps(packageJson);
  const usesManaged = Object.keys(deps).some(d => MANAGED_FRAMEWORKS.some(m => d === m || d.startsWith(m + '/')));
  if (!usesManaged) return false;

  const hasCustomServer = tree.some(p => /^(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !isExcludedPath(p));
  if (hasCustomServer) return false;

  return true;
}

function isPlatformConfigWithoutServer(tree, packageJson) {
  if (!packageJson) return false;
  if (hasDeploymentConfig(tree)) return false;

  const platformConfigs = ['vercel.json', 'netlify.toml', 'wrangler.toml', 'wrangler.json', 'sst.config.ts', 'sst.config.js', 'amplify.yml'];
  const hasPlatformConfig = tree.some(p => !isExcludedPath(p) && platformConfigs.includes(p.toLowerCase().split('/').pop()));
  if (!hasPlatformConfig) return false;

  const prodDeps = packageJson.dependencies || {};
  if (Object.keys(prodDeps).some(d => SERVER_DEPS.has(d))) return false;

  const hasCustomServer = tree.some(p => /^(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !isExcludedPath(p));
  if (hasCustomServer) return false;

  return true;
}

async function isStaticExport(tree, files) {
  const configs = tree.filter(p =>
    !isExcludedPath(p) && (
      /(^|\/)next\.config\.(js|mjs|ts|jsx|tsx)$/i.test(p) ||
      /(^|\/)astro\.config\.(mjs|js|ts)$/i.test(p) ||
      /(^|\/)nuxt\.config\.(ts|js)$/i.test(p) ||
      /(^|\/)svelte\.config\.(js|ts)$/i.test(p)
    )
  ).slice(0, 3);

  for (const cf of configs) {
    const content = await files.get(cf);
    if (!content) continue;
    if (/output\s*:\s*['"`]export['"`]/.test(content)) return true;
    if (/ssr\s*:\s*false/.test(content)) return true;
    if (/target\s*:\s*['"`]static['"`]/.test(content)) return true;
    if (/adapter\s*:\s*static/.test(content)) return true;
  }
  return false;
}

function isClearlyDeployableServer(tree, packageJson) {
  const hasDeployConfig = hasDeploymentConfig(tree);
  const prodDeps = packageJson?.dependencies || {};
  const hasProdServerDep = Object.keys(prodDeps).some(d => SERVER_DEPS.has(d));
  const hasStart = hasProductionStartScript(packageJson);

  const hasServerEntry = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !isExcludedPath(p));
  const hasApiDir = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !isExcludedPath(p));
  const hasRoutesDir = tree.some(p => /(^|\/)routes\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !isExcludedPath(p));
  const hasProcfile = tree.some(p => /(^|\/)Procfile$/i.test(p) && !isExcludedPath(p));

  const frameworkWithCustomServer = ['next', 'nuxt', 'astro'].some(f => prodDeps[f]) && hasServerEntry;

  if (hasDeployConfig && (hasServerEntry || hasApiDir || hasRoutesDir)) return true;
  if (hasProdServerDep && hasStart && (hasServerEntry || hasApiDir || hasRoutesDir)) return true;
  if (hasProcfile && (hasProdServerDep || hasServerEntry || hasApiDir)) return true;
  if (frameworkWithCustomServer && hasStart) return true;

  return false;
}

function looksLikeHealthEndpoint(path) {
  if (isExcludedPath(path)) return false;
  const base = path.split('/').pop();
  const healthName = /^(health|healthz|health-check|status|ready|readiness|alive|liveness|ping|up|heartbeat)(\.route|\.handler|\.controller|\.endpoint|\.api)?\.(js|ts|mjs|cjs|jsx|tsx)$/i;
  if (!healthName.test(base)) return false;

  return /(^|\/)pages\/api\//i.test(path) ||
    /(^|\/)app\/(api\/)?.*\/route\.(js|ts|jsx|tsx)$/i.test(path) ||
    /(^|\/)api\//i.test(path) ||
    /(^|\/)routes\//i.test(path) ||
    /(^|\/)server\/api\//i.test(path) ||
    /(^|\/)src\/(?:app\/)?api\//i.test(path) ||
    /(^|\/)src\/routes\//i.test(path) ||
    /(^|\/)handlers\//i.test(path) ||
    /(^|\/)controllers\//i.test(path) ||
    /(^|\/)functions\//i.test(path) ||
    /(^|\/)workers\//i.test(path) ||
    /(^|\/)middleware\//i.test(path) ||
    /\.(route|router|controller|handler|endpoint|middleware)\./i.test(path);
}

function scoreServerFile(path) {
  let score = 0;
  if (/\.(test|spec)\./i.test(path) || isExcludedPath(path)) return -100;

  if (/^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(path)) score += 16;
  else if (/(^|\/)((app|pages)\/api|api\/|server\/api|src\/api|workers\/|functions\/|controllers\/|handlers\/|routes\/)\//i.test(path)) score += 13;
  else if (/(^|\/)((src\/)?(routes|server|backend|middleware))\//i.test(path)) score += 9;
  else if (/(^|\/)((netlify|edge)[-_]?functions|functions)\//i.test(path)) score += 8;
  else if (/\.(route|router|controller|handler|endpoint|middleware)\./i.test(path)) score += 5;
  else if (/\.(js|ts|mjs|cjs)$/i.test(path)) score += 2;

  if (path.startsWith('src/')) score += 2;
  if (/^examples?\//i.test(path)) score -= 6;
  if (path.split('/').length > 8) score -= 4;
  return score;
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    const healthFile = tree.find(looksLikeHealthEndpoint);
    if (healthFile) {
      return { checkId, status: 'pass', confidence: 'high', message: `Health endpoint file found: ${healthFile}`, findings: [{ file: healthFile, issue: 'Health route file detected' }] };
    }

    const healthLib = hasHealthDependency(packageJson);
    if (healthLib) {
      return { checkId, status: 'pass', confidence: 'high', message: `Health check library present: ${healthLib}`, findings: [{ file: 'package.json', issue: `Uses ${healthLib}` }] };
    }

    const script = healthScriptName(packageJson);
    if (script) {
      return { checkId, status: 'pass', confidence: 'high', message: `Health check script found: "${script}"`, findings: [{ file: 'package.json', issue: `Script "${script}" indicates health monitoring` }] };
    }

    const dockerfile = tree.find(p => !isExcludedPath(p) && (/(^|\/)dockerfile$/i.test(p) || /(^|\/)dockerfile\./i.test(p)));
    if (dockerfile) {
      const content = await files.get(dockerfile);
      if (content && /^\s*HEALTHCHECK\b/im.test(content)) {
        return { checkId, status: 'pass', confidence: 'high', message: `HEALTHCHECK instruction in ${dockerfile}`, findings: [{ file: dockerfile, issue: 'Docker HEALTHCHECK found' }] };
      }
    }

    const composeFile = tree.find(p => !isExcludedPath(p) && /(^|\/)docker-compose\.(yml|yaml)$/i.test(p));
    if (composeFile) {
      const content = await files.get(composeFile);
      if (content && /healthcheck\s*:/i.test(content)) {
        return { checkId, status: 'pass', confidence: 'high', message: `Health check in ${composeFile}`, findings: [{ file: composeFile, issue: 'Docker Compose healthcheck found' }] };
      }
    }

    const k8sFiles = tree.filter(p => !isExcludedPath(p) && (/(^|\/)k8s\//i.test(p) || /(^|\/)kubernetes\//i.test(p) || /(^|\/)helm\//i.test(p)));
    for (const f of k8sFiles.slice(0, 3)) {
      const content = await files.get(f);
      if (content && (/(liveness|readiness|startup)Probe\s*:/i.test(content) || /path:\s*["']?\/(health|status|ready|alive|ping)/i.test(content))) {
        return { checkId, status: 'pass', confidence: 'high', message: `K8s health probe in ${f}`, findings: [{ file: f, issue: 'Kubernetes probe detected' }] };
      }
    }

    const platformFiles = [
      { pattern: /(^|\/)fly\.toml$/i, re: /http_checks|healthcheck|path\s*=\s*["']\/(health|status|ping)/i },
      { pattern: /(^|\/)render\.yaml$/i, re: /healthCheckPath|\/health/i },
      { pattern: /(^|\/)app\.yaml$/i, re: /health_check|readiness_check|liveness_check|\/health/i },
    ];
    for (const { pattern, re } of platformFiles) {
      const file = tree.find(p => !isExcludedPath(p) && pattern.test(p));
      if (file) {
        const content = await files.get(file);
        if (content && re.test(content)) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health check config in ${file}`, findings: [{ file, issue: 'Platform health check configured' }] };
        }
      }
    }

    const workspacePkgs = tree.filter(p => /^(apps|services|packages|workers|tools)\/[^/]+\/package\.json$/i.test(p) && !isExcludedPath(p)).slice(0, 10);
    for (const p of workspacePkgs) {
      const content = await files.get(p);
      if (!content) continue;
      try {
        const pkg = JSON.parse(content);
        const wsHealthLib = hasHealthDependency(pkg);
        if (wsHealthLib) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health check library in workspace ${p}: ${wsHealthLib}`, findings: [{ file: p, issue: `Uses ${wsHealthLib}` }] };
        }
        const wsScript = healthScriptName(pkg);
        if (wsScript) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health check script in workspace ${p}: "${wsScript}"`, findings: [{ file: p, issue: `Script "${wsScript}"` }] };
        }
      } catch (e) { /* ignore parse errors */ }
    }

    if (repoType === RepoType.LIBRARY || repoType === RepoType.EMPTY || repoType === RepoType.TOOL) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library, empty, or tool repository', findings: [] };
    }

    if (isLibraryPackage(packageJson, tree)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library package without deployable server', findings: [] };
    }

    if (isFrameworkSource(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Framework or library source code', findings: [] };
    }

    if (isBuildTool(packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Build tool, CLI, or task runner', findings: [] };
    }

    if (isTutorialRepo(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Tutorial, course, or examples repository', findings: [] };
    }

    if (isPlatformManagedFramework(tree, packageJson) || isPlatformConfigWithoutServer(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Platform-managed deployment without custom server; health check not required', findings: [] };
    }

    if (await isStaticExport(tree, files)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Static site export detected; health check not required', findings: [] };
    }

    const serverFiles = tree
      .filter(p => /\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p) && !isExcludedPath(p))
      .map(p => ({ path: p, score: scoreServerFile(p) }))
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map(f => f.path);

    const HEALTH_CODE_PATTERNS = [
      /\.(get|post|put|delete|all|use|route)\s*\(\s*['"`]\/(api\/)?(healthz?|health[-_]?check|status|readyz?|readiness|alive|livez?|liveness|ping|up|heartbeat)\b/i,
      /pathname\s*===?\s*['"`]\/(api\/)?(healthz?|health[-_]?check|status|readyz?|readiness|alive|livez?|liveness|ping|up|heartbeat)\b/i,
      /new\s+URL\s*\([^)]*\)\.pathname\s*===?\s*['"`]\/(api\/)?(healthz?|status|readyz?|alive|ping|up)\b/i,
      /event\.(path|node\.req\.url|request\.url).*(health|status|ready|alive|ping)/i,
      /(defineEventHandler|eventHandler)\s*\(.*(health|status|ready|alive|ping)/i,
      /@Get\s*\(['"`]health['"`]\)/i,
      /@Controller\s*\(['"`]health['"`]\)/i,
      /lightship|terminus|under-pressure|express-actuator|@nestjs\/terminus|healthcheck-middleware|koa-healthcheck/i,
      /livenessProbe|readinessProbe|startupProbe/i,
      /json\s*\(\s*\{[^}]*status\s*:\s*['"`](ok|up|healthy|passing)['"`]/i,
      /export\s+(default\s+)?function\s+(health|status|ping|ready|alive)/i,
      /export\s+const\s+(health|status|ping|ready|alive)/i,
      /module\.exports\s*=.*health/i,
      /\/\/\s*health\s*check/i,
      /health[-_]?check/i,
      /app\.get\s*\(\s*['"`]\/(api\/)?health/i,
      /app\.use\s*\(\s*['"`]\/health/i,
      /router\.(get|post|all)\s*\(\s*['"`]\/(api\/)?health/i,
    ];

    for (const file of serverFiles) {
      const content = await files.get(file);
      if (!content) continue;
      for (const pattern of HEALTH_CODE_PATTERNS) {
        if (pattern.test(content)) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health endpoint found in ${file}`, findings: [{ file, issue: 'Health route or probe detected' }] };
        }
      }
    }

    if (isClearlyDeployableServer(tree, packageJson)) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: 'Deployable server detected but no health check endpoint found',
        findings: serverFiles.length > 0
          ? serverFiles.slice(0, 3).map(f => ({ file: f, issue: 'Server file scanned, no health endpoint found' }))
          : [{ file: 'package.json', issue: 'Runtime server signals present, but no health endpoint was found' }],
      };
    }

    return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No clear deployable server signals requiring health check', findings: [] };
  } catch (err) {
    console.error('[health-check] Error:', err);
    return { checkId, status: 'not-applicable', confidence: 'low', message: `Analysis error: ${err.message}`, findings: [] };
  }
}