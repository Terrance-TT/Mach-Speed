export const checkId = 'health-check';
export const name = 'Health Check Route';
export const appliesTo = ['deployable', 'server', 'framework'];

const HEALTH_LIBS = new Set([
  'lightship', 'terminus', 'express-actuator', 'under-pressure',
  '@nestjs/terminus', 'healthcheck-middleware', 'koa-healthcheck',
]);

const META_FRAMEWORKS = new Set([
  'next', 'nuxt', 'remix', 'astro', 'solid-start', 'qwik-city',
  'nitro', 'nitropack', 'hono', 'elysia',
]);

const SERVER_DEPS = new Set([
  'express', 'fastify', 'koa', 'hapi', 'micro', 'restify',
  'connect', 'polka', 'http-server', 'serve-static', 'ws', 'socket.io',
  'nitropack', 'nitro', 'h3', 'hono', 'elysia', 'uwebsockets',
]);

function depMatchesMetaFramework(dep) {
  const d = dep.toLowerCase();
  if (META_FRAMEWORKS.has(d)) return true;
  if (d.includes('svelte') && d.includes('kit')) return true;
  if (d.includes('remix')) return true;
  return false;
}

function depMatchesServer(dep) {
  const d = dep.toLowerCase();
  if (SERVER_DEPS.has(d)) return true;
  if (depMatchesMetaFramework(dep)) return true;
  return false;
}

const HEALTH_PATH_RE = [
  /(^|\/)healthz?\.(js|ts|mjs|cjs|jsx|tsx|go|py|rs|java|rb|php)$/i,
  /(^|\/)health[-_]?check\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)status\.(js|ts|mjs|cjs|jsx|tsx|go|py|rs|java|rb|php)$/i,
  /(^|\/)ping\.(js|ts|mjs|cjs|jsx|tsx|go|py|rs|java|rb|php)$/i,
  /(^|\/)ready\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)alive\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)up\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)livez?\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)readyz?\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)api\/(health|status|ping|ready|alive)\/.*\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)api\/(health|status|ping|ready|alive)\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)pages\/api\/(health|status|ping|ready|alive)\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)app\/(api\/)?(health|status|ping|ready|alive)\/route\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)src\/app\/(api\/)?(health|status|ping|ready|alive)\/route\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)src\/pages\/api\/(health|status|ping|ready|alive)\.(js|ts|mjs|cjs|jsx|tsx)$/i,
  /(^|\/)server\/(api\/)?(health|status|ping|ready|alive)\.(js|ts|mjs|cjs)$/i,
  /(^|\/)server\/routes\/(health|status|ping|ready|alive)\.(js|ts|mjs|cjs)$/i,
  /(^|\/)routes\/(health|status|ping|ready|alive)\/\+server\.(js|ts)$/i,
  /(^|\/)src\/routes\/(health|status|ping|ready|alive)\/\+server\.(js|ts)$/i,
  /(^|\/)routes\/(api\.)?(health|status)\.(js|ts|tsx|jsx)$/i,
  /(^|\/)app\/routes\/(health|status)\.(js|ts|tsx|jsx)$/i,
  /(^|\/)controllers\/(health|status)\.(js|ts|mjs|cjs)$/i,
  /(^|\/)handlers\/(health|status)\.(js|ts|mjs|cjs)$/i,
  /(^|\/)middleware\/(health|status)\.(js|ts|mjs|cjs)$/i,
  /(^|\/)workers?\/(health|status)\.(js|ts|mjs|cjs)$/i,
  /(^|\/)functions\/(api\/)?(health|status)\.(js|ts|mjs|cjs)$/i,
  /(^|\/)probes\/(liveness|readiness|health)\.(js|ts|yaml|yml|json)$/i,
  /(^|\/)cmd\/.*\/(health|status)\.go$/i,
  /(^|\/)internal\/.*\/(health|status)\.go$/i,
  /(^|\/)api\/.*\/(health|status)\.py$/i,
  /(^|\/)src\/.*\/(health|status)\.rs$/i,
];

const HEALTH_CODE_RE = [
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/healthz?\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/[^'"]*health[^'"]*['"`]/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/status\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/ready\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/alive\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/ping\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/livez?\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/readyz?\b/i,
  /\.(get|post|put|delete|all|use)\s*\(\s*['"`]\/up\b/i,
  /pathname\s*===?\s*['"`]\/(health|status|ready|alive|ping)\b/i,
  /new\s+URL\s*\([^)]*\)\.pathname\s*===?\s*['"`]\/(health|status|ready|alive|ping)\b/i,
  /event\.(path|node\.req\.url|request\.url).*(health|status|ready|alive|ping)/i,
  /defineEventHandler\s*\(.*(health|status|ready|alive|ping)/i,
  /eventHandler\s*\(.*(health|status|ready|alive|ping)/i,
  /@Get\s*\(['"`]health['"`]\)/i,
  /@Controller\s*\(['"`]health['"`]\)/i,
  /lightship|terminus|under-pressure|express-actuator|@nestjs\/terminus/i,
  /health\s*check|healthcheck/i,
  /livenessProbe|readinessProbe|startupProbe/i,
  /export\s+(async\s+)?function\s+(GET|POST|handler).*(health|status|ready|alive|ping)/i,
  /export\s+default\s+(async\s+)?function.*(health|status|ready|alive|ping)/i,
  /app\.(get|post|all|use)\s*\(\s*['"`]\/health/i,
  /app\.(get|post|all|use)\s*\(\s*['"`]\/status/i,
  /router\.(get|post|all|use)\s*\(\s*['"`]\/health/i,
  /server\.(get|post|all|use)\s*\(\s*['"`]\/health/i,
  /fastify\.(get|route)\s*\(\s*\{?\s*url\s*:\s*['"`]\/health/i,
  /return\s+(new\s+)?Response\s*\(\s*['"`]?(OK|ok|healthy|up|running)/i,
  /json\s*\(\s*\{.*status.*:\s*['"`]?(ok|up|healthy)/i,
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
      /^render\.yaml$/i.test(p) ||
      /^railway\.toml$/i.test(p) ||
      /^Procfile$/i.test(p) ||
      /^app\.yaml$/i.test(p) ||
      /(^|\/)k8s\//i.test(p) ||
      /(^|\/)kubernetes\//i.test(p) ||
      /(^|\/)helm\//i.test(p);
  });
}

function isFrameworkSource(tree, packageJson) {
  const hasPackages = tree.filter(p => /^packages\/[^/]+\/package\.json$/i.test(p)).length >= 2;
  const hasDeployables = tree.some(p => /^(apps|services|workers)\/[^/]+\/package\.json$/i.test(p));

  if (hasPackages && !hasDeployables) {
    const pkgCount = tree.filter(p => /^packages\/[^/]+\/package\.json$/i.test(p)).length;
    if (pkgCount >= 3) return true;
    if (packageJson?.private && (packageJson?.workspaces || tree.some(p => /^pnpm-workspace\.yaml$/i.test(p)))) {
      if (!hasProductionStartScript(packageJson)) return true;
    }
  }

  if ((packageJson?.main || packageJson?.module || packageJson?.exports) && !hasProductionStartScript(packageJson)) {
    const hasServerCode = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
    const hasApiDir = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p) && !/(test|example|demo|playground)\//i.test(p));
    if (!hasServerCode && !hasApiDir && !hasDeployables) return true;
  }

  const exampleCount = tree.filter(p => /^examples?\/[^/]+\//i.test(p)).length;
  if (exampleCount >= 3 && !hasProductionStartScript(packageJson) && !hasDeployables) return true;

  return false;
}

function isTutorialRepo(tree, packageJson) {
  const name = (packageJson?.name || '').toLowerCase();
  const desc = (packageJson?.description || '').toLowerCase();
  const text = `${name} ${desc}`;

  if (/\b(learn|tutorial|course|how[- ]?to|playground|starter[- ]?template|examples?[- ]?app|getting[- ]?started|teach|training|workshop|bootcamp|school|walkthrough|guide[- ]?app)\b/.test(text)) {
    return true;
  }
  if (/-(learn|tutorial|course|starter|examples?|playground|workshop|walkthrough)$/.test(name)) return true;

  const tutorialDirs = ['examples', 'example', 'starters', 'starter', 'learn', 'tutorial', 'tutorials', 'course', 'playground', 'demos', 'demo', 'chapters', 'lessons', 'exercises', 'solutions', 'walkthrough', 'workshop'];
  let dirCount = 0;
  for (const d of tutorialDirs) {
    const hasPkg = tree.some(p => new RegExp(`(^|/)${d}/[^/]+/package\\.json$`, 'i').test(p));
    const hasReadme = tree.some(p => new RegExp(`(^|/)${d}/[^/]+/readme`, 'i').test(p));
    if (hasPkg || hasReadme) dirCount++;
  }
  if (dirCount >= 2) return true;

  const lessonDirs = tree.filter(p => /(^|\/)(chapters?|lessons?|steps?|parts?|basics|advanced)\/[^/]+/i.test(p) || /(^|\/)\d+[-_][^/]+/i.test(p));
  if (lessonDirs.length >= 3) return true;

  return false;
}

function isBuildTool(packageJson) {
  if (!packageJson) return false;
  const text = `${packageJson.name || ''} ${(packageJson.keywords || []).join(' ')}`.toLowerCase();
  return /\b(monorepo|build[- ]?tool|bundler|compiler|task[- ]?runner|orchestrator|cli[- ]?tool|scaffold|generator)\b/.test(text);
}

function isPlatformManaged(tree, packageJson) {
  if (!packageJson) return false;
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const depList = Object.keys(deps);

  const hasCustomServer = tree.some(p => /^(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasRawServerDep = depList.some(d => SERVER_DEPS.has(d));
  if (hasCustomServer || hasRawServerDep) return false;

  const platformConfigs = ['vercel.json', 'netlify.toml', 'wrangler.toml', 'app.yaml', 'serverless.yml', 'serverless.yaml', 'serverless.json', 'render.yaml', 'railway.toml'];
  const hasPlatformConfig = tree.some(p => platformConfigs.includes(p.toLowerCase()));
  return hasPlatformConfig;
}

async function isContentSite(tree, packageJson, files) {
  if (!packageJson) return false;
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const depList = Object.keys(deps);

  const hasCustomServer = tree.some(p => /^(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasRawServerDep = depList.some(d => SERVER_DEPS.has(d));
  if (hasCustomServer || hasRawServerDep) return false;

  const staticGenerators = ['astro', 'gatsby', 'vuepress', 'docusaurus', '@docusaurus/core', 'eleventy', '@11ty/eleventy', 'hexo', 'nextra', 'next-mdx-remote', 'contentlayer', '@contentlayer/core', 'vitepress'];
  if (depList.some(d => staticGenerators.some(sg => d.toLowerCase().includes(sg)))) {
    const mdCount = tree.filter(p => /\.mdx?$/i.test(p) && !/^(README|CHANGELOG|LICENSE|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)/i.test(p.split('/').pop() || '')).length;
    if (mdCount >= 3) return true;
  }

  const configFiles = tree.filter(p => /^next\.config\.(js|mjs|ts)$/i.test(p) || /^astro\.config\.(mjs|js|ts)$/i.test(p) || /^nuxt\.config\.(ts|js)$/i.test(p));
  for (const cf of configFiles.slice(0, 2)) {
    const content = await files.get(cf);
    if (content) {
      if (/output\s*:\s*['"]export['"]/.test(content)) return true;
      if (/output\s*:\s*['"]static['"]/.test(content)) return true;
      if (/ssr\s*:\s*false/.test(content)) return true;
    }
  }

  const mdCount = tree.filter(p => /\.mdx?$/i.test(p) && !/^(README|CHANGELOG|LICENSE|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)/i.test(p.split('/').pop() || '')).length;
  const codeCount = tree.filter(p => /\.(js|ts|jsx|tsx|go|rs|py|java|php|cjs|mjs)$/i.test(p) && !/(node_modules|\.github)/i.test(p)).length;

  if (mdCount >= 8 && mdCount > codeCount * 0.15) {
    const contentDirs = ['content', 'blog', 'data', 'i18n', 'locales', 'posts', 'articles', 'guides', 'docs-content', 'blog-posts', 'snippets', 'news', 'releases', 'events', 'tutorials'];
    const hasContentDir = contentDirs.some(d => tree.some(p => new RegExp(`(^|/)${d}/`, 'i').test(p)));
    if (hasContentDir) return true;
  }

  return false;
}

function isLibrary(tree, packageJson) {
  if (!packageJson) return false;
  if (hasProductionStartScript(packageJson)) return false;
  if (hasDeploymentConfig(tree)) return false;

  const hasExports = packageJson.exports || packageJson.main || packageJson.module;
  if (!hasExports) return false;

  const hasServerEntry = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  if (hasServerEntry) return false;

  const hasApiRoutes = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p) && !/(example|demo|playground|test|__tests__|fixtures?)\//i.test(p));
  if (hasApiRoutes) return false;

  const hasWorkspaceApps = tree.some(p => /^(apps|services|workers)\/[^/]+\/package\.json$/i.test(p));
  if (hasWorkspaceApps) return false;

  return true;
}

function scoreServerFile(path) {
  let score = 0;
  if (/\.(test|spec)\./.test(path)) return -100;
  if (/(__tests__|__mocks__|fixtures?|examples?|demo|playground|benchmark|docs|\.github|\.storybook|scripts\/|dist\/|build\/|coverage\/|storybook\/|bin\/|cli\/|config\/|vitest|jest|knip|lint|\.vscode|node_modules)\//i.test(path)) return -100;

  if (/^(src\/)?(server|app|main|index)\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(path)) score += 15;
  else if (/(^|\/)((app|pages)\/api|app\/.*\/route\.|api\/|server\/api|src\/api|workers\/|functions\/|controllers\/|handlers\/|routes\/)\//i.test(path)) score += 12;
  else if (/(^|\/)((src\/)?(routes|server|backend|middleware))\//i.test(path)) score += 8;
  else if (/(^|\/)((netlify|supabase|edge)[-_]?functions|functions)\//i.test(path)) score += 8;
  else if (/\.(route|router|controller|handler|endpoint|middleware)\./i.test(path)) score += 5;
  else if (/\.(jsx|tsx)$/i.test(path)) score += 1;

  if (path.startsWith('src/')) score += 2;
  if (/components?\/|ui\/|widgets?\/|pages\/(?!api)/i.test(path)) score -= 5;
  if (path.split('/').length > 8) score -= 4;
  return score;
}

function isClearlyDeployableServer(tree, packageJson) {
  if (!packageJson) return false;
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.peerDependencies };
  const depList = Object.keys(deps);
  const hasServerDep = depList.some(depMatchesServer);
  const hasMeta = depList.some(depMatchesMetaFramework);
  const hasStart = hasProductionStartScript(packageJson);
  const hasInfra = hasDeploymentConfig(tree);

  const hasServerEntry = tree.some(p => /^(src\/)?(server|app|main)\.(js|ts|mjs|cjs)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));
  const hasApiRoutes = tree.some(p => /(^|\/)api\/.*\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p) && !/(example|demo|playground|test|__tests__|fixtures?)\//i.test(p));
  const hasPagesApi = tree.some(p => /(^|\/)pages\/api\/.*\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p) && !/(example|demo|playground|test|__tests__|fixtures?)\//i.test(p));
  const hasAppRouter = tree.some(p => /(^|\/)app\/.*\/route\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p) && !/(example|demo|playground|test|__tests__|fixtures?)\//i.test(p));
  const hasMiddleware = tree.some(p => /(^|\/)middleware\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p) && !/(test|spec|example|demo|playground|__tests__|fixtures?)\//i.test(p));

  if (hasInfra && (hasStart || hasServerDep || hasMeta || hasServerEntry || hasApiRoutes)) return true;
  if (hasMeta && hasStart) return true;
  if (hasMeta && (hasPagesApi || hasAppRouter || hasMiddleware || hasServerEntry)) return true;
  if (hasServerDep && (hasStart || hasApiRoutes || hasServerEntry)) return true;
  if (hasStart && (hasServerEntry || hasApiRoutes || hasPagesApi || hasAppRouter)) return true;

  const hasWorkspaceApps = tree.some(p => /^(apps|services|workers)\/[^/]+\/package\.json$/i.test(p));
  if (hasWorkspaceApps && (hasMeta || hasServerDep || hasStart)) return true;

  return false;
}

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    for (const re of HEALTH_PATH_RE) {
      const match = tree.find(p => re.test(p) && !/(test|spec|__tests__|fixtures?|examples?\/|demo\/|playground\/)/i.test(p));
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

    const platformHealthConfigs = [
      { pattern: /^fly\.toml$/i, re: /http_checks|healthcheck|path\s*=\s*["']\/(health|status|ping)/i },
      { pattern: /^app\.yaml$/i, re: /health_check|readiness_check|liveness_check|\/health/i },
      { pattern: /^render\.yaml$/i, re: /healthCheckPath|\/health/i },
    ];
    for (const { pattern, re } of platformHealthConfigs) {
      const file = tree.find(p => pattern.test(p));
      if (file) {
        const content = await files.get(file);
        if (content && re.test(content)) {
          return { checkId, status: 'pass', confidence: 'high', message: `Health check config in ${file}`, findings: [{ file, issue: 'Platform health check configured' }] };
        }
      }
    }

    const workspacePkgs = tree.filter(p => /^(apps|services|packages|workers)\/[^/]+\/package\.json$/i.test(p)).slice(0, 12);
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

    const fileCount = tree.filter(p => !p.endsWith('/')).length;
    if (fileCount < 3) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Empty or minimal repository', findings: [] };
    }

    if (isTutorialRepo(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Tutorial, course, or examples repository', findings: [] };
    }

    if (await isContentSite(tree, packageJson, files)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Static site or content-driven website; health check not required', findings: [] };
    }

    if (isFrameworkSource(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Framework or library source code', findings: [] };
    }

    if (isBuildTool(packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Build tool or task runner', findings: [] };
    }

    if (isPlatformManaged(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Platform-managed deployment (health check handled by platform)', findings: [] };
    }

    if (isLibrary(tree, packageJson)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library package without server or deployment signals', findings: [] };
    }

    const serverFiles = tree
      .filter(p => /\.(js|ts|mjs|cjs|jsx|tsx)$/i.test(p))
      .map(p => ({ path: p, score: scoreServerFile(p) }))
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(f => f.path);

    for (const file of serverFiles) {
      const content = await files.get(file);
      if (!content) continue;
      for (const pattern of HEALTH_CODE_RE) {
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
        findings: serverFiles.slice(0, 3).map(f => ({ file: f, issue: 'Server file scanned, no health endpoint found' }))
      };
    }

    const depList = Object.keys({ ...packageJson?.dependencies, ...packageJson?.devDependencies });
    const hasMetaOrServerDep = depList.some(d => depMatchesServer(d) || depMatchesMetaFramework(d));
    const hasStart = hasProductionStartScript(packageJson);

    if (serverFiles.length > 0 || (hasMetaOrServerDep && hasStart)) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: 'Server code detected but deployment intent is unclear; verify if a health check is needed',
        findings: serverFiles.slice(0, 3).map(f => ({ file: f, issue: 'Ambiguous server signals' }))
      };
    }

    return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No server or deployable signals detected; health check not required', findings: [] };
  } catch (err) {
    console.error(`[health-check] Error:`, err);
    return { checkId, status: 'not-applicable', confidence: 'low', message: `Analysis error: ${err.message}`, findings: [] };
  }
}