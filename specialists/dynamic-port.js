export const checkId = 'dynamic-port';
export const name = 'Dynamic Port Configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

const isFile = (p) => !p.endsWith('/');
const JS_RE = /\.(?:js|ts|jsx|tsx|mjs|cjs)$/;

function classifyPath(p) {
  if (/^(?:examples?|demos?|test|tests|spec|__tests__|fixtures?|playground|benchmark|docs|\.github|coverage|storybook|stories|\.storybook|e2e|cypress|playwright|mock|mocks|vendor)\//.test(p)) return 'nonprod';
  if (/\.(?:test|spec|d)\.(?:js|ts|jsx|tsx|mjs|cjs)$/.test(p)) return 'nonprod';
  if (/(?:^|\/)node_modules\//.test(p)) return 'nonprod';
  if (/(?:^|\/)dist\//.test(p)) return 'nonprod';
  if (/(?:^|\/)build\//.test(p)) return 'nonprod';
  return 'prod';
}

function hasServerSignals(packageJson, tree) {
  if (!packageJson) return false;
  const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const scripts = packageJson.scripts || {};

  const serverDepRe = /^(?:express|fastify|koa|hono|polka|restify|connect|micro|sirv|serve-static|http-server|next|nuxt|astro|nitro|h3|remix|solid-start)\b/;
  const hasServerDep = Object.keys(deps).some(d => serverDepRe.test(d));

  const hasServerScript = Object.entries(scripts).some(([k, v]) => {
    if (!v) return false;
    return /^(start|serve|dev|preview)$/.test(k) && /node|ts-node|nodemon|pm2|next|nuxt|astro|solid-start|remix|serve|listen|http-server/.test(v);
  });

  const hasDeployArtifact = tree.some(p => isFile(p) && /^(?:Dockerfile|Procfile|fly\.toml|vercel\.json|netlify\.toml|render\.yaml|app\.yaml|wrangler\.toml|docker-compose\.yml|docker-compose\.yaml)$/.test(p));
  const hasRootServerFile = tree.some(p => isFile(p) && /^(?:server|app|index|main|start|listen)\.(?:js|ts|jsx|tsx|mjs|cjs)$/.test(p));
  const hasPagesOrApi = tree.some(p => /^(?:src\/)?(?:pages\/api|app\/api|routes|api)\//.test(p));

  return hasServerDep || hasServerScript || hasDeployArtifact || hasRootServerFile || hasPagesOrApi;
}

function isLibraryOrTool(packageJson, tree) {
  if (!packageJson) return false;
  const scripts = packageJson.scripts || {};
  const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };

  const serverDepRe = /^(?:express|fastify|koa|hono|polka|restify|connect|micro|sirv|serve-static|http-server|next|nuxt|astro|nitro|h3|remix|solid-start)\b/;
  if (Object.keys(deps).some(d => serverDepRe.test(d))) return false;
  if (scripts.start && /node|ts-node|nodemon|pm2|next|nuxt|astro|serve|listen/.test(scripts.start)) return false;
  if (scripts.serve) return false;
  if (scripts.preview && /next|nuxt|astro|vite|solid-start|remix/.test(scripts.preview)) return false;

  if (tree.some(p => isFile(p) && /^(?:Dockerfile|fly\.toml|vercel\.json|netlify\.toml|render\.yaml|app\.yaml|wrangler\.toml)$/.test(p))) return false;
  if (tree.some(p => /^(?:src\/)?(?:pages|app)\//.test(p))) return false;

  const keywords = (packageJson.keywords || []).map(k => k.toLowerCase());
  const toolKw = ['cli', 'tool', 'build', 'bundler', 'compiler', 'monorepo', 'workspace', 'rollup', 'webpack', 'vite', 'esbuild', 'turbo', 'linter', 'parser', 'transform', 'plugin', 'utils', 'utilities'];
  const hasToolKw = keywords.some(k => toolKw.includes(k));

  if (packageJson.bin && !scripts.start) return true;
  if (hasToolKw && !scripts.start) return true;
  if (packageJson.peerDependencies && hasToolKw) return true;

  if (packageJson.private === true && !!packageJson.workspaces && tree.some(p => p.startsWith('packages/')) && !tree.some(p => p.startsWith('apps/'))) {
    if (!scripts.start) return true;
  }

  const mainEntry = packageJson.main || '';
  if ((mainEntry.includes('dist') || mainEntry.includes('lib') || mainEntry.includes('build')) && !scripts.start) return true;

  return false;
}

function hasMetaFrameworkDep(packageJson) {
  if (!packageJson) return false;
  const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const metaRe = /^(?:next|nuxt|astro|solid-start|remix)\b/;
  return Object.keys(deps).some(d => metaRe.test(d));
}

function hasServerDependency(packageJson) {
  if (!packageJson) return false;
  const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const srvRe = /^(?:express|fastify|koa|hono|polka|restify|connect|micro|sirv|serve-static|http-server|nitro|h3)$/;
  return Object.keys(deps).some(d => srvRe.test(d));
}

function selectFiles(tree, packageJson) {
  const candidates = [];
  const add = (p, prio) => {
    if (!isFile(p) || !tree.includes(p)) return;
    candidates.push({ path: p, priority: prio });
  };

  ['package.json', 'Dockerfile', 'Procfile', 'fly.toml', 'vercel.json', 'netlify.toml', 'render.yaml', 'app.yaml', 'wrangler.toml', 'docker-compose.yml', 'docker-compose.yaml']
    .forEach(f => add(f, 0));

  ['server', 'app', 'index', 'main', 'start', 'listen', 'www', 'bin', 'cli', 'run', 'application', 'entry', 'bootstrap', 'gateway', 'serve']
    .forEach(n => {
      ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].forEach(ext => add(`${n}.${ext}`, 1));
    });

  ['src/', 'lib/'].forEach(dir => {
    ['server', 'app', 'index', 'main', 'start', 'listen', 'run', 'application', 'entry', 'bootstrap', 'gateway', 'serve']
      .forEach(n => {
        ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].forEach(ext => add(`${dir}${n}.${ext}`, 2));
      });
  });

  tree.filter(p => /^apps\/[^/]+\/(?:src\/)?(?:server|app|index|main|start|listen)\.(?:js|ts|jsx|tsx|mjs|cjs)$/.test(p))
    .forEach(p => add(p, 3));

  tree.filter(p => /^packages\/[^/]+\/(?:src\/)?(?:server|app|index|main|start|listen)\.(?:js|ts|jsx|tsx|mjs|cjs)$/.test(p))
    .forEach(p => add(p, 4));

  tree.filter(p => isFile(p) && /^(?:next\.config|nuxt\.config|astro\.config|remix\.config|svelte\.config|vite\.config|solid\.config|nitro\.config|webpack\.config|rollup\.config)/.test(p))
    .forEach(p => add(p, 5));

  const deepServer = tree.filter(p => {
    if (!isFile(p)) return false;
    if (!JS_RE.test(p)) return false;
    if (/(?:^|\/)node_modules\//.test(p)) return false;
    if (/(?:^|\/)dist\//.test(p)) return false;
    if (/(?:^|\/)build\//.test(p)) return false;
    if (/\.(?:test|spec|d)\.(?:js|ts|jsx|tsx|mjs|cjs)$/.test(p)) return false;
    return /(?:^|\/)packages\/[^/]+\/.+\/(?:server|app|index|main|listen|port|start|run|serve)\.(?:js|ts|jsx|tsx|mjs|cjs)$/.test(p);
  });
  const seenPackages = new Set();
  for (const p of deepServer.sort()) {
    const m = p.match(/^packages\/([^/]+)\//);
    if (m) {
      if (!seenPackages.has(m[1])) {
        seenPackages.add(m[1]);
        add(p, 6);
        if (seenPackages.size >= 6) break;
      }
    } else {
      add(p, 6);
    }
  }

  tree.filter(p => isFile(p) && /^(?:src\/)?(?:pages\/api|app\/api|routes|api)\//.test(p) && JS_RE.test(p) && !/\.(?:test|spec|d)\./.test(p))
    .slice(0, 6).forEach(p => add(p, 7));

  if (candidates.length < 15) {
    const diverse = tree.filter(p => {
      if (!isFile(p)) return false;
      if (!JS_RE.test(p)) return false;
      if (/\.(?:test|spec|d)\.(?:js|ts|jsx|tsx|mjs|cjs)$/.test(p)) return false;
      if (/(?:^|\/)node_modules\//.test(p)) return false;
      if (/(?:^|\/)dist\//.test(p)) return false;
      if (/(?:^|\/)build\//.test(p)) return false;
      return true;
    });
    const dirs = new Set();
    for (const p of diverse) {
      const top = p.split('/')[0];
      if (!dirs.has(top)) {
        dirs.add(top);
        add(p, 8);
        if (candidates.length >= 20) break;
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    if (!seen.has(c.path)) {
      seen.add(c.path);
      result.push(c.path);
    }
  }
  return result.slice(0, 25);
}

const DYNAMIC_PATTERNS = [
  /process\.env\.PORT\b/,
  /process\.env\['PORT'\]/,
  /process\.env\["PORT"\]/,
  /Deno\.env\.get\(['"]PORT['"]\)/,
  /Bun\.env\.PORT\b/,
  /import\.meta\.env\.PORT\b/,
  /Number\s*\(\s*process\.env\.PORT\s*\)/,
  /parseInt\s*\(\s*process\.env\.PORT\s*\)/,
  /(?<!\w)\+process\.env\.PORT\b/,
  /process\.env\.PORT\s*(?:\|\||\?\?)\s*\d+/,
  /PORT\s*=\s*process\.env\.PORT\b/,
  /\{\s*PORT\s*=\s*\d+\s*\}\s*=\s*process\.env/,
  /listen\s*\(\s*(?:process\.env\.PORT|Deno\.env\.get\(['"]PORT['"]\)|Bun\.env\.PORT|import\.meta\.env\.PORT)/,
  /port\s*:\s*process\.env\.PORT\b/,
  /port\s*:\s*(?:Number|parseInt)?\s*\(?\s*process\.env\.PORT\s*\)?\s*(?:\|\||\?\?)\s*\d+/,
  /port\s*:\s*(?:Number|parseInt)\s*\(\s*process\.env\.PORT\s*\)/,
  /(?:const|let|var)\s+PORT\s*=\s*process\.env\.PORT\b/,
  /app\.set\s*\(\s*['"]port['"]\s*,\s*process\.env\.PORT\b/,
  /server\.listen\s*\(\s*\{\s*port\s*:\s*process\.env\.PORT\b/,
  /listen\s*\(\s*\{\s*port\s*:\s*process\.env\.PORT\b/,
];

const HARDCODED_PATTERNS = [
  /\.listen\s*\(\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
  /listen\s*\(\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
  /port\s*:\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
  /PORT\s*=\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
  /(?:const|let|var)\s+PORT\s*=\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
  /EXPOSE\s+(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
];

function scanScripts(pkg, filePath = 'package.json') {
  const findings = [];
  if (!pkg?.scripts) return findings;
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!script || typeof script !== 'string') continue;
    if (/process\.env\.PORT|\$PORT\b/.test(script)) {
      findings.push({ file: filePath, issue: `Script "${name}" references dynamic PORT` });
    }
    const m = script.match(/\b(?:PORT|port)\s*[=:]\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/);
    if (m) {
      findings.push({ file: filePath, issue: `Script "${name}" hardcodes port ${m[1]}` });
    }
  }
  return findings;
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    if (repoType === 'empty') {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Empty repo — no server port needed', findings: [] };
    }

    if (repoType === 'library' || isLibraryOrTool(packageJson, tree)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library/tool detected — no server port configuration needed', findings: [] };
    }

    const allFindings = [];
    const filesToScan = selectFiles(tree, packageJson);

    allFindings.push(...scanScripts(packageJson).map(f => ({ ...f, location: 'prod' })));

    const subPkgs = tree.filter(p => isFile(p) && /^(?:apps|packages)\/[^/]+\/package\.json$/.test(p));
    for (const subPkgPath of subPkgs.slice(0, 10)) {
      try {
        const content = await files.get(subPkgPath);
        if (!content) continue;
        const subPkg = JSON.parse(content);
        allFindings.push(...scanScripts(subPkg, subPkgPath).map(f => ({ ...f, location: classifyPath(subPkgPath) })));
      } catch (e) {
        // ignore parse/read errors for sub-packages
      }
    }

    for (const filePath of filesToScan) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        const location = classifyPath(filePath);

        if (filePath === 'Dockerfile') {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (/\bEXPOSE\s+\$PORT\b/.test(lines[i])) {
              allFindings.push({ file: filePath, line: i + 1, issue: 'Dockerfile exposes dynamic $PORT', location });
            }
            const hm = lines[i].match(/EXPOSE\s+(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/);
            if (hm) {
              allFindings.push({ file: filePath, line: i + 1, issue: `Dockerfile hardcodes port ${hm[1]}`, location });
            }
          }
          continue;
        }

        if (filePath === 'Procfile') {
          if (/\$PORT/.test(content)) {
            allFindings.push({ file: filePath, issue: 'Procfile references $PORT', location });
          }
          continue;
        }

        if (filePath.endsWith('.json')) {
          continue;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

          for (const pat of DYNAMIC_PATTERNS) {
            if (pat.test(line)) {
              allFindings.push({ file: filePath, line: i + 1, issue: 'Dynamic port configuration (process.env.PORT or equivalent)', location });
              break;
            }
          }

          for (const pat of HARDCODED_PATTERNS) {
            const m = line.match(pat);
            if (m) {
              const port = m[1] || m[2] || 'hardcoded';
              allFindings.push({ file: filePath, line: i + 1, issue: `Hardcoded port (${port})`, location });
              break;
            }
          }
        }
      } catch (err) {
        console.error(`Error reading ${filePath}:`, err);
      }
    }

    const prodDynamic = allFindings.filter(f => f.location === 'prod' && f.issue.startsWith('Dynamic'));
    const prodHardcoded = allFindings.filter(f => f.location === 'prod' && f.issue.startsWith('Hardcoded'));
    const nonprodFindings = allFindings.filter(f => f.location === 'nonprod');

    if (prodDynamic.length > 0 && prodHardcoded.length === 0) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Dynamic port configuration found (process.env.PORT)', findings: allFindings };
    }

    if (prodHardcoded.length > 0 && prodDynamic.length === 0) {
      return { checkId, status: 'fail', confidence: 'high', message: 'Hardcoded port detected — should use process.env.PORT', findings: allFindings };
    }

    if (prodDynamic.length > 0 && prodHardcoded.length > 0) {
      return { checkId, status: 'check-it', confidence: 'medium', message: 'Both dynamic and hardcoded port patterns found in production files', findings: allFindings };
    }

    const hasMetaFramework = hasMetaFrameworkDep(packageJson);
    const hasServerDep = hasServerDependency(packageJson);
    const hasDeployArtifact = tree.some(p => isFile(p) && /^(?:Dockerfile|Procfile|fly\.toml|vercel\.json|netlify\.toml|render\.yaml|app\.yaml|wrangler\.toml|docker-compose\.yml|docker-compose\.yaml)$/.test(p));
    const hasStartScript = packageJson?.scripts?.start || packageJson?.scripts?.serve || packageJson?.scripts?.preview || packageJson?.scripts?.dev;

    if (hasMetaFramework && !hasServerDep && prodHardcoded.length === 0) {
      return { checkId, status: 'pass', confidence: 'medium', message: 'Framework-managed server supports dynamic port configuration', findings: allFindings };
    }

    if (repoType === 'framework' && !prodHardcoded.length && tree.some(p => p.startsWith('packages/'))) {
      return { checkId, status: 'pass', confidence: 'medium', message: 'Framework repo — port configuration handled by framework core', findings: allFindings };
    }

    if (!hasServerSignals(packageJson, tree) && !hasMetaFramework && !hasDeployArtifact && !hasStartScript) {
      return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No server runtime detected — port check not applicable', findings: allFindings };
    }

    if (nonprodFindings.length > 0 && prodDynamic.length === 0 && prodHardcoded.length === 0) {
      return { checkId, status: 'check-it', confidence: 'low', message: 'Port patterns found only in non-production paths (examples/tests)', findings: allFindings };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: 'No definitive port configuration patterns found in scanned files',
      findings: allFindings.length > 0 ? allFindings : [{ file: 'internal', issue: `Scanned ${filesToScan.length} files without detecting port patterns` }]
    };

  } catch (err) {
    console.error('dynamic-port check fatal error:', err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Analysis error: ${err.message}`, findings: [{ file: 'internal', issue: `Fatal error: ${err.message}` }] };
  }
}