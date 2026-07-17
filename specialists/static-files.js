export const checkId = 'static-files';
export const name = 'Static Files Served';
export const appliesTo = ['deployable', 'server'];

const STATIC_SERVING_DEPS = [
  'serve-static', 'express', 'connect', 'polka', 'fastify', 'koa', 'restify', 'hapi', 'hono',
  'sirv', 'http-server', 'live-server', 'serve-handler', 'koa-static', 'fastify-static',
  'hono-static', 'connect-static', 'serve', 'light-server', 'servor', 'httpolyglot', 'local-web-server'
];

const FRAMEWORKS_WITH_BUILTIN_STATIC = [
  'next', 'astro', 'nuxt', 'gatsby', 'vite', 'react-scripts',
  'solid-start', 'qwik-city', 'redwoodjs', 'parcel', 'hexo', 'vuepress',
  'nextra', 'contentlayer'
];

const STATIC_SCRIPT_PATTERNS = [
  /(?:^|\s|;)serve(?:\s+-s|\s+--single|\s+\.|$)/,
  /http-server/,
  /live-server/,
  /vite\s+preview/,
  /sirv/,
  /next\s+start/,
  /astro\s+(preview|dev)/,
  /nuxt\s+(start|preview)/,
  /gatsby\s+serve/,
  /remix-serve/,
  /svelte-kit\s+preview/,
  /polyserve/,
  /python\s+-m\s+http\.server/
];

const CODE_PATTERNS = [
  /express\.static\s*\(/,
  /serve-static/,
  /serve-handler/,
  /sirv\s*\(/,
  /sirv[^/]*static/i,
  /koa-static/,
  /fastify-static/,
  /hono-static/,
  /connect-static/,
  /app\.use\s*\(\s*['"]\/(public|static|assets)/,
  /mount\s*\(\s*['"]\/(public|static|assets)/,
  /serve\s*\(\s*['"]\.\/public/,
  /vite\s+preview/,
  /serve\s+-s/,
  /http-server/,
  /live-server/,
  /file_server/,
  /root\s+\*/,
  /nginx.*root\s+/,
  /assets\s*=\s*\{/,
  /site\s*=\s*\{.*bucket/,
  /publish\s*=\s*["'].*dist/,
  /fastify\.register\s*\(\s*.*static/,
  /app\.register\s*\(\s*.*static/,
  /server\.route\s*\(\s*\{.*path\s*:\s*['"]\/(public|static|assets)/,
  /app\.use\s*\(\s*['"]\/(public|static|assets)/,
  /router\.use\s*\(\s*['"]\/(public|static|assets)/,
  /Bun\.serve/,
  /Deno\.serve/
];

const FRAMEWORK_CONFIG_PATTERNS = [
  /(^|\/)next\.config\./,
  /(^|\/)astro\.config\./,
  /(^|\/)nuxt\.config\./,
  /(^|\/)svelte\.config\./,
  /(^|\/)gatsby-config\./,
  /(^|\/)vite\.config\./,
  /(^|\/)remix\.config\./,
  /(^|\/)quasar\.config\./,
  /(^|\/)eleventy\.config\./,
  /(^|\/)docusaurus\.config\./,
  /(^|\/)vue\.config\./,
  /(^|\/)nextra\.config\./,
  /(^|\/)solid\.config\./
];

const HOSTING_CONFIGS = [
  'vercel.json', 'netlify.toml', 'firebase.json', 'render.yaml', 'fly.toml', 'app.yaml',
  'wrangler.toml', 'wrangler.json', 'cloudflare.json'
];

const isNonAppPath = (p) => /\/(test|tests|__tests__|spec|e2e|fixtures?|examples?|demo|node_modules|\.next|dist|build|coverage|\.github|vendor)\//.test(p);

const getDeps = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return {};
  return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
};

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    const hasPublicDir = tree.some(p => /(^|\/)public\//.test(p) && !isNonAppPath(p));
    const hasStaticDir = tree.some(p => /(^|\/)static\//.test(p) && !isNonAppPath(p));
    const hasAssetsDir = tree.some(p => /(^|\/)assets\//.test(p) && !isNonAppPath(p));
    const hasWwwDir = tree.some(p => /(^|\/)www\//.test(p) && !isNonAppPath(p));
    const hasHtmlEntry = tree.some(p => /(^|\/)index\.html$/.test(p) && !isNonAppPath(p));
    const hasRelevantStatic = hasPublicDir || hasStaticDir || hasAssetsDir || hasWwwDir || hasHtmlEntry;

    if (!hasRelevantStatic) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'No static assets (public/, static/, assets/, www/, or HTML entry) detected; static file serving is not relevant',
        findings: []
      };
    }

    const rootDeps = getDeps(packageJson);
    const rootScripts = packageJson?.scripts || {};
    const allRootScripts = Object.values(rootScripts).join(' ');

    if (STATIC_SERVING_DEPS.some(d => rootDeps[d]) || STATIC_SCRIPT_PATTERNS.some(rx => rx.test(allRootScripts))) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Static file serving configured in root package.json', findings: [] };
    }

    if (FRAMEWORKS_WITH_BUILTIN_STATIC.some(d => rootDeps[d])) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Framework detected that serves static assets automatically', findings: [] };
    }

    const isMonorepo = !!(
      packageJson?.workspaces ||
      tree.some(p => ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json', 'rush.json'].includes(p))
    );

    if (isMonorepo) {
      const subPkgPaths = tree.filter(p => {
        const parts = p.split('/');
        return parts.length > 1 && parts.length <= 4 && parts[parts.length - 1] === 'package.json' && !p.includes('node_modules');
      }).slice(0, 12);

      if (subPkgPaths.length > 0) {
        const subPkgs = await Promise.all(
          subPkgPaths.map(async (p) => {
            try {
              const content = await files.get(p);
              if (!content) return null;
              try {
                return JSON.parse(content);
              } catch (parseErr) {
                console.error(`static-files: failed to parse ${p}:`, parseErr);
                return null;
              }
            } catch (readErr) {
              console.error(`static-files: error reading ${p}:`, readErr);
              return null;
            }
          })
        );

        for (const subPkg of subPkgs) {
          if (!subPkg) continue;
          const subDeps = getDeps(subPkg);
          const subScripts = Object.values(subPkg.scripts || {}).join(' ');
          if (STATIC_SERVING_DEPS.some(d => subDeps[d]) || STATIC_SCRIPT_PATTERNS.some(rx => rx.test(subScripts))) {
            return { checkId, status: 'pass', confidence: 'high', message: 'Static file serving configured in a workspace package', findings: [] };
          }
          if (FRAMEWORKS_WITH_BUILTIN_STATIC.some(d => subDeps[d])) {
            return { checkId, status: 'pass', confidence: 'high', message: 'Workspace package uses a framework that serves static assets automatically', findings: [] };
          }
        }
      }
    }

    const hasFrameworkConfig = FRAMEWORK_CONFIG_PATTERNS.some(rx => tree.some(p => rx.test(p) && !p.includes('node_modules')));
    if (hasFrameworkConfig) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Framework configuration detected; static assets served automatically', findings: [] };
    }

    if (HOSTING_CONFIGS.some(f => tree.includes(f))) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Static hosting platform configuration detected', findings: [] };
    }

    const candidates = [];
    const seen = new Set();
    const add = (p) => { if (p && !seen.has(p)) { seen.add(p); candidates.push(p); } };

    ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'nginx.conf', 'Caddyfile']
      .forEach(f => { if (tree.includes(f)) add(f); });

    tree.filter(p => /^\.github\/workflows\/.+\.ya?ml$/.test(p)).slice(0, 3).forEach(add);

    const sourceFiles = tree.filter(p => {
      const basename = p.split('/').pop() || '';
      return (
        /\.(js|ts|mjs|cjs|go|py|rs|java|php)$/.test(p) &&
        !/(test|spec|example|\.d\.ts|stories|fixture)/i.test(basename) &&
        !/(node_modules|\.next|dist|build|coverage|vendor)\//.test(p) &&
        /\b(server|app|index|main|middleware|router|handler|route|static|config|www|cli|worker|bin)\b/i.test(basename)
      );
    });

    const priority = /(static|middleware|server|config|Dockerfile|nginx|Caddyfile|worker|app)/i;
    sourceFiles.sort((a, b) => {
      const aScore = priority.test(a) ? 2 : 1;
      const bScore = priority.test(b) ? 2 : 1;
      return bScore - aScore;
    });
    sourceFiles.slice(0, 10).forEach(add);

    for (const filePath of candidates.slice(0, 15)) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        for (const pattern of CODE_PATTERNS) {
          if (pattern.test(content)) {
            return {
              checkId,
              status: 'pass',
              confidence: 'high',
              message: `Static file serving detected in ${filePath}`,
              findings: [{ file: filePath, issue: 'Static file serving configuration found' }]
            };
          }
        }
      } catch (readErr) {
        console.error(`static-files: error reading ${filePath}:`, readErr);
      }
    }

    if (repoType === 'library' || repoType === 'tool') {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'medium',
        message: 'Static assets may be present, but repo appears to be a library/tool without deployed static serving',
        findings: []
      };
    }

    const staticLocation = hasPublicDir ? 'public/' : hasStaticDir ? 'static/' : hasAssetsDir ? 'assets/' : hasWwwDir ? 'www/' : 'index.html';
    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'Static assets exist but serving configuration could not be verified',
      findings: [
        { file: staticLocation, issue: 'Static assets detected but no explicit serving dependency, framework, or hosting config found' }
      ]
    };

  } catch (err) {
    console.error('static-files specialist error:', err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Analysis error: ${err.message}`,
      findings: [{ file: 'unknown', issue: `Analysis failed: ${err.message}` }]
    };
  }
}