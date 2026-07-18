import { RepoType } from '../contract.js';

export const checkId = 'health-check';
export const name = 'Health Check Route';
export const appliesTo = ['deployable', 'server', 'framework'];

const HEALTH_LIBS = new Set([
  'lightship', 'terminus', 'express-actuator', 'under-pressure',
]);

const SERVER_DEPS = new Set([
  'express', 'fastify', 'koa', 'hapi', 'micro', 'restify',
  'connect', 'polka', 'http-server', 'serve-static', 'ws', 'socket.io',
  'nitropack', 'nitro', 'h3', 'hono', 'elysia', 'uwebsockets',
]);

const HEALTH_CODE_PATTERNS = [
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/healthz?\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/status\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/ready\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/alive\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/ping\b/i,
  /pathname\s*===?\s*['"`]\/health/i,
  /pathname\s*===?\s*['"`]\/status/i,
  /pathname\s*===?\s*['"`]\/ready/i,
  /event\.(path|node\.req\.url).*(health|status|ready|alive|ping)/i,
  /@Get\s*\(['"`]health['"`]\)/i,
  /@Controller\s*\(['"`]health['"`]\)/i,
  /lightship|terminus|under-pressure|express-actuator/i,
  /livenessProbe|readinessProbe|startupProbe/i,
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
      /(^|\/)k8s\//i.test(p) ||
      /(^|\/)kubernetes\//i.test(p) ||
      /(^|\/)helm\//i.test(p);
  });
}

function isFrameworkSource(tree, packageJson) {
  const hasPackages = tree.filter(p => /^packages\/[^/]+\/package\.json$/i.test(p)).length >= 2;
  const hasApps = tree.some(p => /^apps\/[^/]+\/package\.json$/i.test(p));
  const hasServices = tree.some(p => /^services\/[^/]+\/package\.json$/i.test(p));
  const hasDeployables = hasApps || hasServices;

  if (hasPackages && !hasDeployables) {
    const pkgCount = tree.filter(p => /^packages\/[^/]+\/package\.json$/i.test(p)).length;
    if (pkgCount >= 3) return true;
    if (packageJson?.private && (packageJson?.workspaces || tree.some(p => /^pnpm-workspace\.yaml$/i.test(p)))) {
      if (!hasProductionStartScript(packageJson)) return true;
    }
  }

  if ((packageJson?.main || packageJson?.module || packageJson?.exports) && !hasProductionStartScript(packageJson)) {
    const hasServerCode = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p));
    const hasApiDir = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|example|demo)/i.test(p));
    if (!hasServerCode && !hasApiDir && !hasDeployables) return true;
  }

  const exampleCount = tree.filter(p => /^examples?\/[^/]+\//i.test(p)).length;
  if (exampleCount >= 3 && !hasProductionStartScript(packageJson) && !hasDeployables) return true;

  return false;
}

function isTutorialRepo(tree, packageJson) {
  const name = packageJson?.name || '';
  const desc = packageJson?.description || '';
  const text = `${name} ${desc}`.toLowerCase();
  if (/\b(learn|tutorial|course|starter[- ]?template|playground|examples?[- ]?app)\b/.test(text)) return true;

  const dirs = ['examples', 'example', 'starters', 'starter', 'templates', 'template', 'demos', 'demo', 'playground', 'learn', 'chapters', 'lessons', 'tutorial', 'tutorials', 'course', 'workshop'];
  let count = 0;
  for (const d of dirs) {
    count += tree.filter(p => new RegExp(`^${d}/[^/]+/package\\.json$`, 'i').test(p)).length;
  }
  if (count >= 2) return true;

  return false;
}

function isBuildTool(packageJson) {
  if (!packageJson) return false;
  const text = `${packageJson.name || ''} ${(packageJson.keywords || []).join(' ')}`.toLowerCase();
  return /\b(monorepo|build[- ]?tool|bundler|compiler|task[- ]?runner|orchestrator)\b/.test(text);
}

function isStaticOrPlatformManaged(tree, packageJson) {
  if (!packageJson) return false;
  if (hasDeploymentConfig(tree)) return false;

  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const hasServerDep = Object.keys(deps).some(d => SERVER_DEPS.has(d));
  const hasCustomServer = tree.some(p => /^(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo)/i.test(p));
  if (hasCustomServer || hasServerDep) return false;

  const platformConfigs = ['vercel.json', 'netlify.toml', 'wrangler.toml', 'app.yaml', 'serverless.yml', 'serverless.yaml', 'serverless.json'];
  const hasPlatformConfig = tree.some(p => platformConfigs.includes(p.toLowerCase()));

  const staticConfigs = ['astro.config', 'gatsby-config', 'eleventy.config', '.eleventy.js', 'vuepress.config', 'docusaurus.config'];
  const hasStaticConfig = tree.some(p => {
    const base = p.toLowerCase().split('/').pop();
    return staticConfigs.some(cfg => base.startsWith(cfg));
  });

  return hasPlatformConfig || hasStaticConfig;
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

function isClearlyDeployableServer(tree, packageJson) {
  if (hasDeploymentConfig(tree)) return true;

  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  const hasServer = Object.keys(deps).some(d => SERVER_DEPS.has(d));
  const hasStart = hasProductionStartScript(packageJson);

  const hasApi = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(example|demo|playground|test|__tests__|fixtures?)\//i.test(p));
  const hasServerEntry = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p));
  const hasRoutes = tree.some(p => /(^|\/)routes\/.*\.(js|ts|mjs|cjs)$/i.test(p) && !/(example|demo|playground|test|__tests__|fixtures?)\//i.test(p));

  return hasServer && hasStart && (hasApi || hasServerEntry || hasRoutes);
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
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

    const workspacePkgs = tree.filter(p => /^(apps|services|packages)\/[^/]+\/package\.json$/i.test(p)).slice(0, 5);
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

    if (isFrameworkSource(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Framework or library source code', findings: [] };
    }

    if (isTutorialRepo(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Tutorial, course, or examples repository', findings: [] };
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
      .slice(0, 10)
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

    if (isClearlyDeployableServer(tree, packageJson)) {
      return { checkId, status: 'fail', confidence: 'high', message: 'Deployable server detected but no health check endpoint found', findings: serverFiles.slice(0, 3).map(f => ({ file: f, issue: 'Server file scanned, no health endpoint found' })) };
    }

    return { checkId, status: 'check-it', confidence: 'medium', message: 'Unable to determine if a health check is required or present', findings: serverFiles.length > 0 ? serverFiles.slice(0, 3).map(f => ({ file: f, issue: 'Ambiguous server signals' })) : [{ file: 'N/A', issue: 'No server code candidates found to analyze' }] };

  } catch (err) {
    console.error(`[health-check] Error:`, err);
    return { checkId, status: 'not-applicable', confidence: 'low', message: `Analysis error: ${err.message}`, findings: [] };
  }
}