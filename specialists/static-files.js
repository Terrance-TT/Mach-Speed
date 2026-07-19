export const checkId = 'static-files';
export const name = 'Static Files Served';
export const appliesTo = ['deployable', 'server', 'framework'];

const STATIC_SERVING_DEPS = [
  'serve-static', 'sirv', 'http-server', 'live-server', 'serve-handler',
  'koa-static', 'fastify-static', '@fastify/static', 'hono-static',
  'connect-static', 'serve', 'light-server', 'servor', 'httpolyglot',
  'local-web-server', 'sirv-cli', 'webpack-dev-server', 'vite', 'parcel',
  'http-serve', 'superstatic'
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
  /(?:from|require)\s*\(\s*['"]serve-static['"]\s*\)/,
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
  /router\.use\s*\(\s*['"]\/(public|static|assets)/,
  /mount\s*\(\s*['"]\/(public|static|assets)/,
  /serve\s*\(\s*['"]\.\/public/,
  /vite\s+preview/,
  /serve\s+-s/,
  /http-server/,
  /live-server/,
  /file_server/,
  /nginx.*root\s+/,
  /assets\s*=\s*\{/,
  /site\s*=\s*\{.*bucket/,
  /publish\s*=\s*["'].*dist/,
  /fastify\.register\s*\(\s*.*static/,
  /app\.register\s*\(\s*.*static/,
  /server\.route\s*\(\s*\{.*path\s*:\s*['"]\/(public|static|assets)/,
  /Bun\.serve\s*\(\s*\{[^}]*static/i,
  /serveDir\s*\(/,
  /serveStatic\s*\(/,
  /serveFile\s*\(/,
  /import\s+.*from\s+['"][^'"]*\/file_server\.ts['"]/,
  /res\.sendFile\s*\(/,
  /res\.sendfile\s*\(/,
  /sendFile\s*\(\s*.*(?:public|static|assets)/,
  /createReadStream\s*\(\s*.*(?:public|static|assets)/,
  /send_from_directory\s*\(/,
  /app\.send_static_file/,
  /http\.StripPrefix\s*\(\s*['"]\/(?:public|static|assets)/
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

const LIKELY_BUILD_DIRS = new Set(['dist', 'build', 'out', 'output', '.next', '.nuxt', 'storybook-static']);

const isNonAppPath = (p) => /\/(test|tests|__tests__|spec|e2e|fixtures?|examples?|demo|node_modules|\.next|dist|build|coverage|vendor)\//.test(p);

const getDeps = (pkg) => {
  if (!pkg || typeof pkg !== 'object') return {};
  return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
};

function normalizeServedPath(p) {
  if (!p || typeof p !== 'string') return null;
  p = p.trim();
  if (p === '.' || p === './') return null;
  if (p.startsWith('/')) return null;
  if (p.includes('..')) return null;
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

function treeHasDir(tree, dir) {
  const d = dir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!d) return false;
  return tree.some(entry => {
    const e = entry.replace(/\/+$/, '');
    return e === d || e.startsWith(d + '/');
  });
}

const PATH_EXTRACTION_PATTERNS = [
  /express\.static\s*\(\s*['"`]([^'"`]+)['"`]/,
  /serveStatic\s*\(\s*['"`]([^'"`]+)['"`]/,
  /sirv\s*\(\s*['"`]([^'"`]+)['"`]/,
  /serveDir\s*\(\s*['"`]([^'"`]+)['"`]/,
  /serve\s*\(\s*['"`]([^'"`]+)['"`]/,
  /mount\s*\(\s*['"`]([^'"`]+)['"`]/,
  /sendFile\s*\(\s*['"`]([^'"`]+)['"`]/,
  /sendfile\s*\(\s*['"`]([^'"`]+)['"`]/,
  /send_static_file\s*\(\s*['"`]([^'"`]+)['"`]/,
  /http\.StripPrefix\s*\(\s*['"`]([^'"`]+)['"`]/,
  /Bun\.serve\s*\([^)]*static[^)]*['"`]([^'"`]+)['"`]/,
  /root\s*:\s*['"`]([^'"`]+)['"`]/,
  /base\s*:\s*['"`]([^'"`]+)['"`]/,
  /baseDir\s*:\s*['"`]([^'"`]+)['"`]/,
  /dir\s*:\s*['"`]([^'"`]+)['"`]/,
  /fromDir\s*:\s*['"`]([^'"`]+)['"`]/,
  /path\s*:\s*['"`]([^'"`]+)['"`]/,
  /publicDir\s*:\s*['"`]([^'"`]+)['"`]/,
];

function extractServedPath(line) {
  for (const rx of PATH_EXTRACTION_PATTERNS) {
    const m = line.match(rx);
    if (m && m[1]) {
      const p = normalizeServedPath(m[1]);
      if (p) return p;
    }
  }
  if (/(express\.static|serveStatic|sirv\s*\(|serveDir\s*\(|serve\s*\(|mount\s*\(|sendFile\s*\(|sendfile\s*\(|send_static_file)/.test(line)) {
    const regex = /['"`]([^'"`]+)['"`]/g;
    let mm;
    while ((mm = regex.exec(line)) !== null) {
      const p = normalizeServedPath(mm[1]);
      if (p) return p;
    }
  }
  return null;
}

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
      .filter(p => p !== 'package.json' && p.endsWith('/package.json') && !p.includes('/node_modules/'))
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

    const entryFiles = new Set();
    if (packageJson) {
      if (packageJson.main && typeof packageJson.main === 'string') {
        entryFiles.add(packageJson.main.replace(/^\.\//, ''));
      }
      if (packageJson.bin) {
        const bins = typeof packageJson.bin === 'string' ? [packageJson.bin] : Object.values(packageJson.bin);
        for (const b of bins) {
          if (b && typeof b === 'string') entryFiles.add(b.replace(/^\.\//, ''));
        }
      }
    }

    const sourceFiles = tree.filter(p => {
      const basename = p.split('/').pop() || '';
      const hasCodeExt = /\.(js|ts|mjs|cjs|jsx|tsx)$/.test(p);
      const isBinScript = !basename.includes('.') && /\/bin\//.test(p);
      return (
        (hasCodeExt || isBinScript) &&
        !/(test|spec|example|\.d\.ts|stories|fixture)/i.test(basename) &&
        !/(node_modules|\.next|dist|build|coverage|vendor)\//.test(p) &&
        /\b(server|app|index|main|middleware|router|handler|route|routes|static|config|www|cli|worker|bin|entry|start|setup|bootstrap|listen|factory|web|http|api|service|init|gateway|proxy|daemon|serve|services|listeners|handlers|utils|helpers|controllers|middlewares|src|source|lib|core|backend|frontend|express|fastify|koa|hono|nest|next|nuxt|astro|remix|svelte|vite)\b/i.test(basename)
      );
    });

    const priority = /(server|app|index|main|middleware|router|handler|route|routes|static|config|www|cli|worker|bin|entry|start|setup|bootstrap|listen|factory|web|http|api|service|init|gateway|proxy|daemon|serve|express|fastify|koa|hono|nest|src|source|lib|core)/i;
    sourceFiles.sort((a, b) => {
      const aBase = a.split('/').pop() || '';
      const bBase = b.split('/').pop() || '';
      const aEntry = entryFiles.has(a) || entryFiles.has(aBase) ? 4 : 0;
      const bEntry = entryFiles.has(b) || entryFiles.has(bBase) ? 4 : 0;
      const aNamed = priority.test(aBase) ? 2 : 0;
      const bNamed = priority.test(bBase) ? 2 : 0;
      return (bEntry + bNamed) - (aEntry + aNamed);
    });

    let hasValidStaticServe = false;
    let hasInvalidStaticServe = false;
    const invalidServeFindings = [];

    for (const filePath of sourceFiles.slice(0, 20)) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

          for (const pattern of CODE_PATTERNS) {
            if (pattern.test(line)) {
              const servedPath = extractServedPath(line);
              if (servedPath) {
                if (treeHasDir(tree, servedPath)) {
                  hasValidStaticServe = true;
                } else if (!LIKELY_BUILD_DIRS.has(servedPath)) {
                  hasInvalidStaticServe = true;
                  invalidServeFindings.push({
                    file: filePath,
                    line: i + 1,
                    issue: `Static serving references path '${servedPath}' which does not exist in the repository`
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`static-files: read error for ${filePath}:`, e);
      }
    }

    if (hasValidStaticServe) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: 'Static file serving configuration verified',
        findings: []
      };
    }

    if (hasInvalidStaticServe && hasRelevantStatic) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: 'Static file serving code references a non-existent path while static assets exist elsewhere unserved',
        findings: invalidServeFindings
      };
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