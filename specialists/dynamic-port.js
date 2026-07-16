// specialists/dynamic-port.js — Checks for dynamic port configuration (process.env.PORT)

export const checkId = 'dynamic-port';
export const name = 'Dynamic Port Configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

// =============================================================================
// PATTERNS
// =============================================================================
const GOOD_PATTERNS = [
  /process\.env\.PORT/,
  /process\.env\['PORT'\]/,
  /process\.env\["PORT"\]/,
  /env\.PORT/,
  /PORT\s*[=:]\s*process\.env/,
  /import\.meta\.env\.PORT/,
  /Deno\.env\.get\(['"]PORT['"]\)/,
  /Bun\.env\.PORT/,
  /const\s*\{\s*PORT\s*\}\s*=\s*process\.env/,
  /let\s*\{\s*PORT\s*\}\s*=\s*process\.env/,
  /var\s*\{\s*PORT\s*\}\s*=\s*process\.env/,
];

const BAD_PATTERNS = [
  /\.listen\s*\(\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
  /\.listen\s*\(\s*\{[^}]*port\s*:\s*(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/,
];

const FALLBACK_PATTERNS = [
  /(?:Number|parseInt|\+)?\s*\(?\s*process\.env\.PORT\s*\)?\s*(?:\|\||\?\?)\s*\d+/,
  /\{\s*PORT\s*=\s*\d+\s*\}\s*=\s*process\.env/,
];

// =============================================================================
// NON-PRODUCTION PATHS (excluded from BAD pattern detection for deployable/server repos)
// For framework repos, examples are treated as production code (they're the reference patterns)
// =============================================================================
const NON_PRODUCTION_PATHS = [
  /examples?\//,        /demo\//,            /demos\//,
  /test\//,            /__tests__\//,       /spec\//,
  /benchmark\//,       /perf\//,            /\.github\//,
  /docs\//,            /fixture\//,         /fixtures\//,
  /playground\//,      /sandbox\//,         /stub\//,
  /stubs\//,           /mock\//,            /mocks\//,
  /e2e\//,             /cypress\//,          /playwright\//,
  /storybook\//,        /stories\//,          /\.storybook\//,
  /coverage\//,        /jest\//,             /vitest\//,
];

function isNonProductionPath(filePath) {
  return NON_PRODUCTION_PATHS.some(p => p.test(filePath));
}

// =============================================================================
// FRAMEWORK DETECTION
// =============================================================================
function isFrameworkRepo(tree, packageJson) {
  const frameworkConfigFiles = [
    'next.config.js', 'next.config.ts', 'next.config.mjs',
    'nuxt.config.ts', 'nuxt.config.js',
    'astro.config.mjs', 'astro.config.js', 'astro.config.ts',
    'remix.config.js', 'remix.config.ts',
    'svelte.config.js', 'svelte.config.ts',
    'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
  ];
  const hasFrameworkConfig = frameworkConfigFiles.some(c => tree.includes(c));

  const deps = packageJson?.dependencies || {};
  const devDeps = packageJson?.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  const hasFrameworkDep = allDeps.next || allDeps.nuxt || allDeps.astro || allDeps['@remix-run/dev'] || allDeps['@sveltejs/kit'];

  const hasPagesDir = tree.some(p => /^(src\/)?pages\//.test(p) || /^(src\/)?app\//.test(p));

  return hasFrameworkConfig || hasFrameworkDep || hasPagesDir;
}

// =============================================================================
// LIBRARY DETECTION (defensive against classifier misclassification)
// =============================================================================
function looksLikeLibrary(packageJson, tree) {
  if (!packageJson) return false;

  // If it's a framework repo, it's NOT a library
  if (isFrameworkRepo(tree, packageJson)) return false;

  const deps = packageJson.dependencies || {};
  const devDeps = packageJson.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };

  // Server framework deps = definitely not a library
  const serverDeps = [
    'express', 'fastify', 'koa', 'hono', 'nest',
    'polka', 'restify', 'connect', 'sirv', 'serve-static', 'http-server',
  ];
  if (serverDeps.some(d => allDeps[d])) return false;

  // Start/dev scripts that run a server = not a library
  const scripts = packageJson.scripts || {};
  const hasStartScript = scripts.start && /node|ts-node|nodemon|pm2/.test(scripts.start);
  const hasDevScript = scripts.dev && /next|nuxt|astro|nest|node|ts-node/.test(scripts.dev);
  if (hasStartScript || hasDevScript) return false;

  // Deployable indicators = not a library
  const hasDeployConfig = tree.some(p => /Dockerfile|vercel\.json|netlify\.toml|fly\.toml|render\.yaml/.test(p));
  const hasPagesDir = tree.some(p => /^(src\/)?pages\//.test(p) || /^(src\/)?app\//.test(p));
  if (hasDeployConfig || hasPagesDir) return false;

  // Monorepo library signal: private + workspaces + packages/ + no apps/
  const isMonorepo = packageJson.private === true && !!packageJson.workspaces;
  const hasPackages = tree.some(p => p.startsWith('packages/'));
  const hasApps = tree.some(p => p.startsWith('apps/'));
  if (isMonorepo && hasPackages && !hasApps) return true;

  // Library signal: peer deps + library keywords
  const hasPeerDeps = !!packageJson.peerDependencies;
  const keywords = packageJson.keywords || [];
  const hasLibKeywords = keywords.some(k => /library|component|ui|react|vue|angular|svelte|plugin/.test(k));
  if (hasPeerDeps && hasLibKeywords) return true;

  // Main entry is dist/lib/build
  const mainEntry = packageJson.main || '';
  if ((mainEntry.includes('dist') || mainEntry.includes('lib') || mainEntry.includes('build')) && !hasStartScript) {
    return true;
  }

  return false;
}

// =============================================================================
// FILE SELECTION
// =============================================================================
function getFilePriority(filePath) {
  let priority = 10;
  if (!filePath.includes('/')) priority = 0;
  else if (/^apps\/[^/]+\/server/.test(filePath)) priority = 1;
  else if (/^apps\/[^/]+\/app/.test(filePath)) priority = 1;
  else if (/^apps\/[^/]+\/index/.test(filePath)) priority = 1;
  else if (filePath.startsWith('apps/')) priority = 2;
  else if (filePath.startsWith('demos/')) priority = 2;
  else if (filePath.startsWith('examples/')) priority = 3;
  else if (filePath.startsWith('src/')) priority = 4;
  else if (filePath.startsWith('lib/')) priority = 5;
  else if (filePath.startsWith('bin/')) priority = 6;
  else if (filePath.startsWith('api/')) priority = 7;
  else if (filePath.startsWith('packages/')) priority = 8;

  const filename = filePath.split('/').pop();
  if (filename.includes('server')) priority -= 0.3;
  else if (filename.includes('app')) priority -= 0.2;
  else if (filename.includes('index')) priority -= 0.1;

  return priority;
}

function selectServerFiles(tree, repoType) {
  let candidates = tree.filter(p => {
    const isServerFile = /(server|app|index|main|www|cli|start|bin|run|application|entry|bootstrap|gateway|listener|serve)\./.test(p) && /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p);
    const notTest = !/(\.test\.|\.spec\.|__tests__\/|\.d\.ts$)/.test(p);
    const notBuild = !/(^|\/)node_modules\//.test(p) && !/(^|\/)dist\//.test(p) && !/(^|\/)build\//.test(p);
    return isServerFile && notTest && notBuild;
  });

  if (repoType === 'framework') {
    const exampleFiles = tree.filter(p => {
      const isServerFile = /(server|app|index|main)\./.test(p) && /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p);
      const inExamples = /^(examples?|demos)\//.test(p);
      const notTest = !/(\.test\.|\.spec\.|__tests__\/|\.d\.ts$)/.test(p);
      return isServerFile && inExamples && notTest;
    });
    candidates = [...candidates, ...exampleFiles];
  }

  candidates.sort((a, b) => getFilePriority(a) - getFilePriority(b));
  return candidates.slice(0, 5);
}

function selectConfigFiles(tree) {
  const configPatterns = [
    /next\.config\.(js|ts|mjs)$/,
    /nuxt\.config\.(ts|js)$/,
    /astro\.config\.(mjs|js|ts)$/,
    /remix\.config\.(js|ts)$/,
    /svelte\.config\.(js|ts)$/,
    /vite\.config\.(ts|js|mjs)$/,
  ];
  return tree.filter(p => configPatterns.some(re => re.test(p))).slice(0, 3);
}

function scanScripts(packageJson) {
  const findings = [];
  if (!packageJson?.scripts) return findings;

  const scripts = packageJson.scripts;
  const scriptNames = ['start', 'dev', 'serve', 'preview'];

  for (const name of scriptNames) {
    const script = scripts[name];
    if (!script) continue;

    if (/process\.env\.PORT/.test(script) || script.includes('$PORT')) {
      findings.push({ file: 'package.json', issue: `Script "${name}" uses process.env.PORT: ${script}` });
    }
    const portMatch = script.match(/\b(3000|3001|8080|8081|5000|5001|8000|9000|4000|4200)\b/);
    if (portMatch) {
      findings.push({ file: 'package.json', issue: `Script "${name}" has hardcoded port ${portMatch[1]}: ${script}` });
    }
  }

  return findings;
}

// =============================================================================
// MAIN CHECK
// =============================================================================
export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    if (repoType === 'library' || repoType === 'empty') {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library or empty repo — no server port needed', findings: [] };
    }

    if (looksLikeLibrary(packageJson, tree)) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library detected from package.json — no server port needed', findings: [] };
    }

    const serverFiles = selectServerFiles(tree, repoType);
    const configFiles = selectConfigFiles(tree);
    const allFiles = [...new Set([...serverFiles, ...configFiles])];

    // Static site check: build script but no start script and no server files
    const hasBuildScript = packageJson?.scripts?.build;
    const hasStartScript = packageJson?.scripts?.start;
    if (serverFiles.length === 0 && hasBuildScript && !hasStartScript) {
      return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No server files — may be a static site', findings: [] };
    }

    if (serverFiles.length === 0 && configFiles.length === 0) {
      const scriptFindings = scanScripts(packageJson);
      const scriptDynamic = scriptFindings.some(f => f.issue.includes('process.env.PORT'));
      const scriptHardcoded = scriptFindings.some(f => f.issue.includes('hardcoded'));

      if (scriptDynamic && !scriptHardcoded) {
        return { checkId, status: 'pass', confidence: 'high', message: 'Dynamic port configuration found in package.json scripts', findings: scriptFindings };
      }
      if (scriptHardcoded && !scriptDynamic) {
        return { checkId, status: 'fail', confidence: 'high', message: 'Hardcoded port detected in package.json scripts', findings: scriptFindings };
      }
      if (scriptDynamic && scriptHardcoded) {
        return { checkId, status: 'check-it', confidence: 'medium', message: 'Both dynamic and hardcoded port patterns found in package.json scripts', findings: scriptFindings };
      }

      if (repoType === 'server' || repoType === 'framework') {
        const anyJs = tree.filter(p =>
          /\.(js|ts)$/.test(p) &&
          !/(\.test\.|\.spec\.|__tests__\/|\.d\.ts$|node_modules|dist\/|build\/)/.test(p)
        ).slice(0, 5);

        if (anyJs.length === 0) {
          return { checkId, status: 'check-it', confidence: 'low', message: 'No server entry files found in server/framework repo', findings: [] };
        }
        return await scanFiles(anyJs, files, checkId, repoType, packageJson);
      }

      return { checkId, status: 'check-it', confidence: 'low', message: 'Could not find server entry files', findings: [] };
    }

    return await scanFiles(allFiles, files, checkId, repoType, packageJson);

  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Network timeout while fetching files' : err.message;
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${msg}`, findings: [] };
  }
}

// =============================================================================
// FILE SCANNING
// =============================================================================
async function scanFiles(fileList, files, checkId, repoType, packageJson) {
  let foundDynamic = false;
  let foundHardcoded = false;
  let foundFallback = false;
  const findings = [];
  const seenFindings = new Set();

  for (const filePath of fileList) {
    const content = await files.get(filePath);
    if (!content) continue;
    const lines = content.split('\n');
    const isNonProd = repoType !== 'framework' && isNonProductionPath(filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('//')) continue;

      for (const pattern of GOOD_PATTERNS) {
        if (pattern.test(line)) {
          foundDynamic = true;
          const key = `${filePath}:${i + 1}:dynamic`;
          if (!seenFindings.has(key)) {
            seenFindings.add(key);
            findings.push({ file: filePath, line: i + 1, issue: 'Uses process.env.PORT' });
          }
        }
      }

      for (const badPattern of BAD_PATTERNS) {
        const badMatch = line.match(badPattern);
        if (badMatch) {
          const port = badMatch[1];
          if (isNonProd) {
            const key = `${filePath}:${i + 1}:nonprod:${port}`;
            if (!seenFindings.has(key)) {
              seenFindings.add(key);
              findings.push({ file: filePath, line: i + 1, issue: `Hardcoded port (non-prod): ${port}` });
            }
          } else {
            foundHardcoded = true;
            const key = `${filePath}:${i + 1}:hardcoded:${port}`;
            if (!seenFindings.has(key)) {
              seenFindings.add(key);
              findings.push({ file: filePath, line: i + 1, issue: `Hardcoded port: ${port}` });
            }
          }
        }
      }

      for (const fallbackPattern of FALLBACK_PATTERNS) {
        const fallbackMatch = line.match(fallbackPattern);
        if (fallbackMatch) {
          if (isNonProd) {
            const key = `${filePath}:${i + 1}:nonprod-fallback`;
            if (!seenFindings.has(key)) {
              seenFindings.add(key);
              findings.push({ file: filePath, line: i + 1, issue: `Fallback hardcoded port (non-prod): ${fallbackMatch[0]}` });
            }
          } else {
            foundFallback = true;
            const key = `${filePath}:${i + 1}:fallback`;
            if (!seenFindings.has(key)) {
              seenFindings.add(key);
              findings.push({ file: filePath, line: i + 1, issue: `Fallback hardcoded port: ${fallbackMatch[0]}` });
            }
          }
        }
      }
    }
  }

  const scriptFindings = scanScripts(packageJson);
  for (const sf of scriptFindings) {
    if (sf.issue.includes('process.env.PORT')) {
      foundDynamic = true;
    } else if (sf.issue.includes('hardcoded')) {
      foundHardcoded = true;
    }
    findings.push(sf);
  }

  if (foundDynamic && !foundHardcoded && !foundFallback) {
    return { checkId, status: 'pass', confidence: 'high', message: 'Dynamic port configuration found (process.env.PORT)', findings };
  }

  if (foundHardcoded && !foundDynamic) {
    return { checkId, status: 'fail', confidence: 'high', message: 'Hardcoded port detected — should use process.env.PORT', findings };
  }

  if (foundFallback && !foundDynamic && !foundHardcoded) {
    return { checkId, status: 'check-it', confidence: 'medium', message: 'Fallback hardcoded port found (process.env.PORT || 3000) — consider removing fallback', findings };
  }

  if (foundDynamic && (foundHardcoded || foundFallback)) {
    return { checkId, status: 'check-it', confidence: 'medium', message: 'Both dynamic and hardcoded port patterns found', findings };
  }

  const nonProdFindings = findings.filter(f => f.issue.includes('(non-prod)'));
  if (nonProdFindings.length > 0 && !foundDynamic && !foundHardcoded && !foundFallback) {
    return { checkId, status: 'check-it', confidence: 'medium', message: 'Hardcoded ports found only in examples/tests — no production patterns detected', findings: nonProdFindings };
  }

  return { checkId, status: 'check-it', confidence: 'medium', message: 'No port configuration found', findings: [] };
}
