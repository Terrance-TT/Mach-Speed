import { RepoType } from '../contract.js';

export const checkId = 'health-check';
export const name = 'Health Check Route';
export const appliesTo = ['deployable', 'server', 'framework'];

const HEALTH_LIBS = new Set([
  'lightship', 'terminus', 'express-actuator', 'under-pressure',
  '@nestjs/terminus', 'healthcheck-middleware', 'koa-healthcheck',
]);

const SERVER_DEPS = new Set([
  'express', 'fastify', 'koa', 'hapi', 'micro', 'restify',
  'connect', 'polka', 'http-server', 'serve-static', 'ws', 'socket.io',
  'nitropack', 'nitro', 'h3', 'hono', 'elysia', 'uwebsockets',
]);

const META_FRAMEWORKS = new Set([
  'next', 'nuxt', 'remix', 'solid-start', 'astro', 'qwik-city', 'hono', 'nitro', 'nitropack', 'nuxt-edge',
]);

const HEALTH_PATH_PATTERNS = [
  /(^|\/)health\.(js|ts|mjs|cjs|go|py|rs|java|rb|php)$/i,
  /(^|\/)healthz\.(js|ts|mjs|cjs|go|py|rs|java|rb|php)$/i,
  /(^|\/)health-check\.(js|ts|mjs|cjs)$/i,
  /(^|\/)healthcheck\.(js|ts|mjs|cjs)$/i,
  /(^|\/)status\.(js|ts|mjs|cjs|go|py|rs|java|rb|php)$/i,
  /(^|\/)ping\.(js|ts|mjs|cjs|go|py|rs|java|rb|php)$/i,
  /(^|\/)ready\.(js|ts|mjs|cjs)$/i,
  /(^|\/)alive\.(js|ts|mjs|cjs)$/i,
  /(^|\/)up\.(js|ts|mjs|cjs)$/i,
  /(^|\/)livez\.(js|ts|mjs|cjs)$/i,
  /(^|\/)readyz\.(js|ts|mjs|cjs)$/i,
  /(^|\/)api\/health\/.*\.(js|ts|mjs|cjs)$/i,
  /(^|\/)api\/status\/.*\.(js|ts|mjs|cjs)$/i,
  /(^|\/)api\/ping\/.*\.(js|ts|mjs|cjs)$/i,
  /(^|\/)api\/ready\/.*\.(js|ts|mjs|cjs)$/i,
  /(^|\/)pages\/api\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)pages\/api\/status\.(js|ts|mjs|cjs)$/i,
  /(^|\/)pages\/api\/ping\.(js|ts|mjs|cjs)$/i,
  /(^|\/)pages\/api\/ready\.(js|ts|mjs|cjs)$/i,
  /(^|\/)app\/api\/health\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)app\/api\/status\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)app\/health\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)app\/status\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)app\/ready\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)app\/ping\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)routes\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)routes\/status\.(js|ts|mjs|cjs)$/i,
  /(^|\/)routes\/ping\.(js|ts|mjs|cjs)$/i,
  /(^|\/)routes\/ready\.(js|ts|mjs|cjs)$/i,
  /(^|\/)controllers\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)controllers\/status\.(js|ts|mjs|cjs)$/i,
  /(^|\/)handlers\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)handlers\/status\.(js|ts|mjs|cjs)$/i,
  /(^|\/)server\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)server\/status\.(js|ts|mjs|cjs)$/i,
  /(^|\/)health\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)status\/route\.(js|ts|mjs|cjs)$/i,
  /(^|\/)health\/index\.(js|ts|mjs|cjs)$/i,
  /(^|\/)status\/index\.(js|ts|mjs|cjs)$/i,
  /(^|\/)workers\/.*health.*\.(js|ts|mjs|cjs)$/i,
  /(^|\/)functions\/.*health.*\.(js|ts|mjs|cjs)$/i,
  /(^|\/)functions\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)functions\/status\.(js|ts|mjs|cjs)$/i,
  /(^|\/)src\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)src\/status\.(js|ts|mjs|cjs)$/i,
  /(^|\/)src\/routes\/health\.(js|ts|mjs|cjs)$/i,
  /(^|\/)src\/routes\/status\.(js|ts|mjs|cjs)$/i,
];

const HEALTH_CODE_PATTERNS = [
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/healthz?\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/_?health\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/healthcheck\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/status\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/ready\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/alive\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/ping\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/livez?\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/readyz?\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/up\b/i,
  /pathname\s*===?\s*['"`]\/health/i,
  /pathname\s*===?\s*['"`]\/status/i,
  /pathname\s*===?\s*['"`]\/ready/i,
  /pathname\s*===?\s*['"`]\/ping/i,
  /event\.(path|node\.req\.url).*(health|status|ready|alive|ping)/i,
  /@Get\s*\(['"`]health['"`]\)/i,
  /@Controller\s*\(['"`]health['"`]\)/i,
  /lightship|terminus|under-pressure|express-actuator/i,
  /livenessProbe|readinessProbe|startupProbe/i,
  /health\s*check|healthcheck/i,
  /router\.(get|post)\s*\(\s*['"`]\/health/i,
  /app\.(get|post|use)\s*\(\s*['"`]\/health/i,
  /fastify\.(get|route)\s*\(\s*\{?\s*url\s*:\s*['"`]\/health/i,
  /new\s+Response\s*\(\s*['"`]ok['"`]/i,
];

function hasProductionStartScript(packageJson) {
  if (!packageJson?.scripts) return false;
  for (const [name, cmd] of Object.entries(packageJson.scripts)) {
    if (name === 'start' || /^start:/i.test(name)) {
      if (cmd && !/^(docs?|dev|build|watch|storybook|lint|test|tsc|typecheck|clean|bench|benchmark)/i.test(cmd)) {
        return true;
      }
    }
  }
  return false;
}

function hasHealthDependency(packageJson) {
  if (!packageJson) return null;
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.peerDependencies };
  return Object.keys(deps).find(d => HEALTH_LIBS.has(d)) || null;
}

function hasDeploymentConfig(tree) {
  return tree.some(p => {
    if (/(example|demo|playground|test|__tests__|fixtures?|docs)\//i.test(p)) return false;
    const l = p.toLowerCase();
    return l === 'dockerfile' || l.startsWith('dockerfile.') ||
      /^docker-compose\.(yml|yaml)$/i.test(p) ||
      /^fly\.toml$/i.test(p) ||
      /^captain-definition$/i.test(p) ||
      /^Procfile$/i.test(p) ||
      /^app\.yaml$/i.test(p) ||
      /^render\.yaml$/i.test(p) ||
      /^railway\.toml$/i.test(p) ||
      /^wrangler\.toml$/i.test(p) ||
      /^netlify\.toml$/i.test(p) ||
      /^vercel\.json$/i.test(p) ||
      /(^|\/)k8s\//i.test(p) ||
      /(^|\/)kubernetes\//i.test(p) ||
      /(^|\/)helm\//i.test(p) ||
      /(^|\/)cdktf\//i.test(p) ||
      /(^|\/)terraform\//i.test(p) ||
      /(^|\/)pulumi\//i.test(p);
  });
}

function isFrameworkSource(tree, packageJson) {
  const hasPackages = tree.filter(p => /^packages\/[^/]+\/package\.json$/i.test(p)).length >= 2;
  const hasApps = tree.some(p => /^apps\/[^/]+\/package\.json$/i.test(p));
  const hasServices = tree.some(p => /^services\/[^/]+\/package\.json$/i.test(p));
  const hasWorkers = tree.some(p => /^workers\/[^/]+\/package\.json$/i.test(p));
  const hasDeployables = hasApps || hasServices || hasWorkers;

  if (hasPackages && !hasDeployables) {
    const pkgCount = tree.filter(p => /^packages\/[^/]+\/package\.json$/i.test(p)).length;
    if (pkgCount >= 3) return true;
    if (packageJson?.private && (packageJson?.workspaces || tree.some(p => /^pnpm-workspace\.yaml$/i.test(p)))) {
      if (!hasProductionStartScript(packageJson)) return true;
    }
  }

  if ((packageJson?.main || packageJson?.module || packageJson?.exports) && !hasProductionStartScript(packageJson)) {
    const hasServerCode = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo)/i.test(p));
    const hasApiDir = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|example|demo)/i.test(p));
    if (!hasServerCode && !hasApiDir && !hasDeployables) return true;
  }

  const exampleCount = tree.filter(p => /^examples?\/[^/]+\//i.test(p)).length;
  if (exampleCount >= 3 && !hasProductionStartScript(packageJson) && !hasDeployables) return true;

  return false;
}

function isTutorialRepo(context, tree, packageJson) {
  if (isFrameworkSource(tree, packageJson)) return false;

  const repoText = `${context.owner || ''} ${context.repo || ''}`.toLowerCase();
  const name = packageJson?.name || '';
  const desc = packageJson?.description || '';
  const text = `${name} ${desc}`.toLowerCase();
  const fullText = `${repoText} ${text}`;

  if (/\b(learn|tutorial|course|how[- ]?to|playground|starter[- ]?template|examples?[- ]?app|getting[- ]?started|teach|training|workshop|bootcamp|school|walkthrough|guide[- ]?app)\b/.test(fullText)) {
    return true;
  }

  const courseDirs = [
    'basics', 'dashboard', 'foundations', 'essentials', 'getting-started',
    'advanced', 'beginner', 'intermediate', 'steps', 'exercises', 'solutions',
    'chapters', 'lessons', 'tutorial', 'tutorials', 'course', 'workshop',
    'learn', 'part', 'section', 'unit', 'module', 'demo', 'demos',
    'example', 'examples', 'starter', 'starters', 'template', 'templates',
    'playground', 'showcase', '01-', '02-', '03-', '04-', '05-', '06-', '07-', '08-', '09-', '10-'
  ];

  let courseDirCount = 0;
  for (const d of courseDirs) {
    if (tree.some(p => new RegExp(`(^|/)${d}/`, 'i').test(p))) courseDirCount++;
  }
  if (courseDirCount >= 2) return true;

  let examplePkgCount = 0;
  for (const d of courseDirs) {
    examplePkgCount += tree.filter(p => new RegExp(`(^|/)${d}/[^/]+/package\\.json$`, 'i').test(p)).length;
  }
  if (examplePkgCount >= 2 && /\b(example|demo|starter|template|playground|learn|tutorial)\b/.test(fullText)) return true;

  if (hasDeploymentConfig(tree) && hasProductionStartScript(packageJson)) return false;

  const topLevelDirs = new Set(
    tree
      .filter(p => p.includes('/') && (p.match(/\//g) || []).length === 1)
      .map(p => p.split('/')[0].toLowerCase())
  );
  const exampleDirNames = new Set(['examples', 'example', 'demos', 'demo', 'playground', 'tutorials', 'tutorial', 'learn', 'starters', 'starter', 'templates', 'template', 'basics', 'dashboard', 'solutions', 'exercises', 'steps']);
  const isExampleHeavy = [...topLevelDirs].filter(d => exampleDirNames.has(d)).length >= 2;
  if (isExampleHeavy && !hasProductionStartScript(packageJson)) return true;

  return false;
}

function isBuildTool(packageJson) {
  if (!packageJson) return false;
  const text = `${packageJson.name || ''} ${(packageJson.keywords || []).join(' ')}`.toLowerCase();
  return /\b(monorepo|build[- ]?tool|bundler|compiler|task[- ]?runner|orchestrator)\b/.test(text);
}

function depMatchesMetaFramework(d) {
  if (META_FRAMEWORKS.has(d)) return true;
  if (d.includes('remix')) return true;
  if (d.includes('svelte') && d.includes('kit')) return true;
  return false;
}

function isStaticOrPlatformManaged(tree, packageJson) {
  if (!packageJson) return false;
  if (hasDeploymentConfig(tree)) return false;

  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const depList = Object.keys(deps);
  const hasServerDep = depList.some(d => SERVER_DEPS.has(d));
  const hasMetaFramework = depList.some(depMatchesMetaFramework);
  const hasCustomServer = tree.some(p => /^(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo)/i.test(p));
  const hasApiRoutes = tree.some(p => /(^|\/)pages\/api\/|(^|\/)app\/.*\/route\./i.test(p));
  if (hasCustomServer || hasApiRoutes || hasServerDep || hasMetaFramework) return false;

  const platformConfigs = ['vercel.json', 'netlify.toml', 'wrangler.toml', 'app.yaml', 'serverless.yml', 'serverless.yaml', 'serverless.json'];
  const hasPlatformConfig = tree.some(p => platformConfigs.includes(p.toLowerCase()));
  if (hasPlatformConfig) return true;

  const staticConfigs = ['astro.config', 'gatsby-config', 'eleventy.config', '.eleventy.js', 'vuepress.config', 'docusaurus.config', 'vite.config', 'rollup.config', 'webpack.config', 'parcel.config'];
  const hasStaticConfig = tree.some(p => {
    const base = p.toLowerCase().split('/').pop();
    return staticConfigs.some(cfg => base.startsWith(cfg));
  });

  return hasStaticConfig && !hasServerDep && !hasMetaFramework && !hasCustomServer && !hasApiRoutes;
}

function scoreServerFile(path) {
  let score = 0;
  if (/\.(test|spec)\./.test(path)) return -100;
  if (/(__tests__|__mocks__|fixtures?|examples?|demo|playground|benchmark|docs|\.github|\.storybook|scripts|dist|build|coverage|storybook|bin|cli|config|vitest|jest|knip|lint|\.vscode|node_modules)\//i.test(path)) return -100;

  if (/^(src\/)?(server|app|main|index)\.(js|ts|mjs|cjs)$/i.test(path)) score += 15;
  else if (/(^|\/)((app|pages)\/api|api\/|server\/api|src\/api|workers\/|functions\/|controllers\/|handlers\/|routes\/)\//i.test(path)) score += 12;
  else if (/(^|\/)((src\/)?(routes|server|backend|middleware))\//i.test(path)) score += 8;
  else if (/(^|\/)((netlify|supabase|edge)[-_]?functions|functions)\//i.test(path)) score += 8;
  else if (/\.(route|router|controller|handler|endpoint|middleware)\./i.test(path)) score += 5;

  if (path.startsWith('src/')) score += 2;
  if (path.split('/').length > 8) score -= 4;
  return score;
}

function isDeployableServer(tree, packageJson) {
  if (!packageJson) return false;

  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.peerDependencies };
  const depList = Object.keys(deps);
  const hasServerDep = depList.some(d => SERVER_DEPS.has(d));
  const hasMetaFramework = depList.some(depMatchesMetaFramework);
  const hasStart = hasProductionStartScript(packageJson);

  const hasDocker = tree.some(p => /(^|\/)dockerfile$/i.test(p) || /(^|\/)dockerfile\./i.test(p));
  const hasCompose = tree.some(p => /^docker-compose\.(yml|yaml)$/i.test(p));
  const hasK8s = tree.some(p => /(^|\/)k8s\//i.test(p) || /(^|\/)kubernetes\//i.test(p) || /(^|\/)helm\//i.test(p));
  const hasProcfile = tree.some(p => /^Procfile$/i.test(p));
  const hasFly = tree.some(p => /^fly\.toml$/i.test(p));

  const hasServerEntry = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasApiRoutes = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasPagesApi = tree.some(p => /(^|\/)pages\/api\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasAppRouter = tree.some(p => /(^|\/)app\/.*\/route\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasWorkers = tree.some(p => /(^|\/)workers?\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasFunctions = tree.some(p => /(^|\/)functions\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasMiddleware = tree.some(p => /(^|\/)middleware\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));

  const infraSignals = [hasDocker, hasCompose, hasK8s, hasProcfile, hasFly].filter(Boolean).length;
  const codeSignals = [hasServerEntry, hasApiRoutes, hasPagesApi, hasAppRouter, hasWorkers, hasFunctions, hasMiddleware].filter(Boolean).length;

  if (infraSignals > 0 && (hasStart || hasServerDep || hasMetaFramework)) return true;
  if (hasServerDep && hasStart) return true;
  if (hasMetaFramework && hasStart) return true;
  if (hasMetaFramework && codeSignals > 0) return true;
  if (hasServerDep && codeSignals > 0) return true;
  if (hasStart && codeSignals > 0) return true;

  const hasWorkspaceApps = tree.some(p => /^(apps|services|workers)\/[^/]+\/package\.json$/i.test(p));
  if (hasWorkspaceApps && (hasMetaFramework || hasServerDep || hasStart)) return true;

  return false;
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    for (const pattern of HEALTH_PATH_PATTERNS) {
      const match = tree.find(p => pattern.test(p) && !/(test|spec|__tests__|fixtures?|examples?\/|demo\/|playground\/)/i.test(p));
      if (match) {
        return { checkId, status: 'pass', confidence: 'high', message: `Health endpoint file found: ${match}`, findings: [{ file: match, issue: 'Health route file detected' }] };
      }
    }

    const healthLib = hasHealthDependency(packageJson);
    if (healthLib) {
      return { checkId, status: 'pass', confidence: 'high', message: `Health check library present: ${healthLib}`, findings: [{ file: 'package.json', issue: `Uses ${healthLib}` }] };
    }

    if (packageJson?.scripts) {
      for (const [name] of Object.entries(packageJson.scripts)) {
        if (/^(health|healthcheck|status|ping|ready|alive)/i.test(name)) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health check script found: "${name}"`, findings: [{ file: 'package.json', issue: `Script "${name}" indicates health monitoring` }] };
        }
      }
    }

    const dockerfile = tree.find(p => /(^|\/)dockerfile$/i.test(p) || /(^|\/)dockerfile\./i.test(p));
    if (dockerfile) {
      const content = await files.get(dockerfile);
      if (content && /healthcheck/i.test(content)) {
        return { checkId, status: 'pass', confidence: 'high', message: `HEALTHCHECK instruction in ${dockerfile}`, findings: [{ file: dockerfile, issue: 'Docker HEALTHCHECK found' }] };
      }
    }

    const composeFile = tree.find(p => /^docker-compose\.(yml|yaml)$/i.test(p));
    if (composeFile) {
      const content = await files.get(composeFile);
      if (content && /healthcheck/i.test(content)) {
        return { checkId, status: 'pass', confidence: 'high', message: `Health check in ${composeFile}`, findings: [{ file: composeFile, issue: 'Docker Compose healthcheck found' }] };
      }
    }

    const k8sFiles = tree.filter(p => /(^|\/)k8s\//i.test(p) || /(^|\/)kubernetes\//i.test(p) || /(^|\/)helm\//i.test(p));
    for (const f of k8sFiles.slice(0, 3)) {
      const content = await files.get(f);
      if (content && (/(liveness|readiness|startup)Probe/i.test(content) || /path:\s*\/(health|status|ready|alive|ping)/i.test(content))) {
        return { checkId, status: 'pass', confidence: 'high', message: `K8s health probe in ${f}`, findings: [{ file: f, issue: 'Kubernetes probe detected' }] };
      }
    }

    const workspacePkgs = tree.filter(p => /^(apps|services|packages|workers)\/[^/]+\/package\.json$/i.test(p)).slice(0, 8);
    for (const p of workspacePkgs) {
      const content = await files.get(p);
      if (!content) continue;
      try {
        const pkg = JSON.parse(content);
        const wsHealthLib = hasHealthDependency(pkg);
        if (wsHealthLib) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health check library in workspace ${p}: ${wsHealthLib}`, findings: [{ file: p, issue: `Uses ${wsHealthLib}` }] };
        }
        if (pkg.scripts) {
          for (const [name] of Object.entries(pkg.scripts)) {
            if (/^(health|healthcheck|status|ping|ready|alive)/i.test(name)) {
              return { checkId, status: 'pass', confidence: 'high', message: `Health check script in workspace ${p}: "${name}"`, findings: [{ file: p, issue: `Script "${name}"` }] };
            }
          }
        }
      } catch (e) { /* ignore parse errors */ }
    }

    if (repoType === RepoType.LIBRARY || repoType === RepoType.EMPTY || repoType === RepoType.TOOL) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library, empty, or tool repository', findings: [] };
    }

    if (isTutorialRepo(context, tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Tutorial, course, or examples repository', findings: [] };
    }

    if (isFrameworkSource(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Framework or library source code', findings: [] };
    }

    if (isBuildTool(packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Build tool or task runner', findings: [] };
    }

    if (isStaticOrPlatformManaged(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Static site or platform-managed deployment', findings: [] };
    }

    const serverFiles = tree
      .filter(p => /\.(js|ts|mjs|cjs)$/i.test(p))
      .map(p => ({ path: p, score: scoreServerFile(p) }))
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(f => f.path);

    for (const file of serverFiles) {
      const content = await files.get(file);
      if (!content) continue;
      for (const pattern of HEALTH_CODE_PATTERNS) {
        if (pattern.test(content)) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health endpoint found in ${file}`, findings: [{ file, issue: 'Health route or probe detected' }] };
        }
      }
    }

    if (isDeployableServer(tree, packageJson)) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: 'Deployable server detected but no health check endpoint found',
        findings: serverFiles.slice(0, 3).map(f => ({ file: f, issue: 'Server file scanned, no health endpoint found' }))
      };
    }

    const hasSomeServerSignals = serverFiles.length > 0 || (packageJson && hasProductionStartScript(packageJson));
    if (hasSomeServerSignals) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: 'Some server signals found but deployment intent is unclear; verify if a health check is needed',
        findings: serverFiles.slice(0, 3).map(f => ({ file: f, issue: 'Ambiguous server signals' }))
      };
    }

    return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No server or deployable signals detected; health check not required', findings: [] };
  } catch (err) {
    console.error(`[health-check] Error:`, err);
    return { checkId, status: 'not-applicable', confidence: 'low', message: `Analysis error: ${err.message}`, findings: [] };
  }
}