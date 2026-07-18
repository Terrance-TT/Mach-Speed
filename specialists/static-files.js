export const checkId = 'static-files';
export const name = 'Static Files Served';
export const appliesTo = ['deployable', 'server', 'framework'];

const STATIC_SERVING_DEPS = [
  'serve-static', 'express', 'connect', 'polka', 'fastify', 'koa', 'restify', 'hapi', 'hono',
  'sirv', 'http-server', 'live-server', 'serve-handler', 'koa-static', 'fastify-static', '@fastify/static',
  'hono-static', 'connect-static', 'serve', 'light-server', 'servor', 'httpolyglot', 'local-web-server',
  'sirv-cli', 'webpack-dev-server', 'vite', 'parcel', 'http-serve', 'superstatic', 'ngrok'
];

const FRAMEWORKS_WITH_BUILTIN_STATIC = [
  'next', 'astro', 'nuxt', 'gatsby', 'vite', 'react-scripts',
  'solid-start', 'qwik-city', 'redwoodjs', 'parcel', 'hexo', 'vuepress',
  'nextra', 'contentlayer', 'docusaurus', '@docusaurus/core',
  'vitepress', 'slidev', 'elm-pages', 'gridsome', 'sapper', 'elderjs',
  'scully', 'ionic', '@ionic/core', 'stencil', '@stencil/core',
  '@vue/cli-service'
];

const STATIC_SCRIPT_PATTERNS = [
  /(?:^|\s|;)serve(?:\s+-s|\s+--single|\s+\.|$)/,
  /http-server/,
  /live-server/,
  /vite\s+preview/,
  /sirv/,
  /next\s+start/,
  /astro\s+(preview|dev)/,
  /nuxt\s+(start|preview|dev)/,
  /gatsby\s+serve/,
  /remix-serve/,
  /svelte-kit\s+preview/,
  /polyserve/,
  /python\s+-m\s+http\.server/,
  /nginx/,
  /caddy\s+file-server/,
  /serve\s+-/,
  /serve\s+['"]\.\//,
  /wrangler\s+(pages\s+dev|publish)/,
  /firebase\s+serve/,
  /netlify\s+dev/,
  /vercel\s+(dev|deploy)/,
  /surge/,
  /gh-pages/
];

const CODE_PATTERNS = [
  /express\.static\s*\(/,
  /serve-static/,
  /serve-handler/,
  /sirv\s*\(/,
  /sirv[^/]*static/i,
  /koa-static/,
  /fastify-static/,
  /['"]@fastify\/static['"]/,
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
  /Bun\.serve\s*\(\s*\{[^}]*static/,
  /Deno\.serve\s*\(/,
  /serveDir/,
  /serveStatic/,
  /serveFile/,
  /import\s+.*from\s+['"][^'"]*\/file_server\.ts['"]/,
  /const\s+app\s*=\s*new\s+Hono/
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
  /(^|\/)solid\.config\./,
  /(^|\/)vitepress\.config\./
];

const HOSTING_CONFIGS = [
  'vercel.json', 'netlify.toml', 'firebase.json', 'render.yaml', 'fly.toml', 'app.yaml',
  'wrangler.toml', 'wrangler.json', 'cloudflare.json'
];

const isNonAppPath = (p) => /\/(test|tests|__tests__|spec|e2e|fixtures?|examples?|demo|node_modules|\.next|dist|build|coverage|vendor)\//.test(p);

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

    const checkPkg = (pkg) => {
      if (!pkg) return null;
      const deps = getDeps(pkg);
      const scripts = pkg.scripts || {};
      const allScripts = Object.values(scripts).join(' ');
      if (STATIC_SERVING_DEPS.some(d => deps[d])) {
        return { status: 'pass', reason: 'Static file serving dependency found' };
      }
      if (FRAMEWORKS_WITH_BUILTIN_STATIC.some(d => deps[d])) {
        return { status: 'pass', reason: 'Framework with built-in static serving detected' };
      }
      if (STATIC_SCRIPT_PATTERNS.some(rx => rx.test(allScripts))) {
        return { status: 'pass', reason: 'Static serving script detected' };
      }
      return null;
    };

    const rootResult = checkPkg(packageJson);
    if (rootResult) {
      return { checkId, status: 'pass', confidence: 'high', message: rootResult.reason, findings: [] };
    }

    const subPkgPaths = tree
      .filter(p => p !== 'package.json' && p.endsWith('package.json') && !p.includes('/node_modules/'))
      .slice(0, 15);

    if (subPkgPaths.length > 0) {
      const subPkgs = await Promise.all(
        subPkgPaths.map(async (p) => {
          try {
            const content = await files.get(p);
            if (!content) return null;
            try {
              return JSON.parse(content);
            } catch (e) {
              console.error(`static-files: JSON parse error in ${p}:`, e);
              return null;
            }
          } catch (e) {
            console.error(`static-files: read error for ${p}:`, e);
            return null;
          }
        })
      );

      for (const subPkg of subPkgs) {
        if (!subPkg) continue;
        const subResult = checkPkg(subPkg);
        if (subResult) {
          return { checkId, status: 'pass', confidence: 'high', message: `${subResult.reason} in workspace`, findings: [] };
        }
      }
    }

    const hasFrameworkConfig = FRAMEWORK_CONFIG_PATTERNS.some(rx =>
      tree.some(p => rx.test(p) && !isNonAppPath(p))
    );
    if (hasFrameworkConfig) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Framework configuration detected; static assets served automatically', findings: [] };
    }

    const hasHostingConfig = HOSTING_CONFIGS.some(f => tree.includes(f));
    if (hasHostingConfig) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Static hosting platform configuration detected', findings: [] };
    }

    const infraFiles = [];
    const seenInfra = new Set();
    const addInfra = (p) => { if (p && !seenInfra.has(p)) { seenInfra.add(p); infraFiles.push(p); } };

    ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'nginx.conf', 'Caddyfile']
      .forEach(f => { if (tree.includes(f)) addInfra(f); });

    tree.filter(p => /^\.github\/workflows\/.+\.ya?ml$/.test(p)).slice(0, 3).forEach(addInfra);

    for (const filePath of infraFiles) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        if (/nginx|serve\s+-s|http-server|live-server|sirv|python\s+-m\s+http\.server|caddy\s+file-server|vite\s+preview|COPY\s+.*\/public|COPY\s+.*\/static/.test(content)) {
          return { checkId, status: 'pass', confidence: 'high', message: `Static file serving detected in ${filePath}`, findings: [{ file: filePath, issue: 'Static file serving configuration found' }] };
        }
      } catch (e) {
        console.error(`static-files: read error for ${filePath}:`, e);
      }
    }

    const sourceFiles = tree.filter(p => {
      const basename = p.split('/').pop() || '';
      return (
        /\.(js|ts|mjs|cjs|go|py|rs|java|php)$/.test(p) &&
        !/(test|spec|example|\.d\.ts|stories|fixture)/i.test(basename) &&
        !/(node_modules|\.next|dist|build|coverage|vendor)\//.test(p) &&
        /\b(server|app|index|main|middleware|router|handler|route|static|config|www|cli|worker|bin|entry|start)\b/i.test(basename)
      );
    });

    const priority = /(static|middleware|server|config|Dockerfile|nginx|Caddyfile|worker|app)/i;
    sourceFiles.sort((a, b) => {
      const aScore = priority.test(a) ? 2 : 1;
      const bScore = priority.test(b) ? 2 : 1;
      return bScore - aScore;
    });

    for (const filePath of sourceFiles.slice(0, 10)) {
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
      } catch (e) {
        console.error(`static-files: read error for ${filePath}:`, e);
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