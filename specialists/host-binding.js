// specialists/host-binding.js — Checks if server binds to 0.0.0.0 (all interfaces)
// Required for Render.com, Railway, and most cloud platforms.
// Binding only to localhost/127.0.0.1 makes the server unreachable externally.

export const checkId = 'host-binding';
export const name = 'Host Binding (0.0.0.0)';
export const appliesTo = ['deployable', 'server', 'framework'];

// ---- Patterns ----

// GOOD: explicit 0.0.0.0 binding
const GOOD_PATTERNS = [
  /['"]0\.0\.0\.0['"]/,
  /host\s*[=:]\s*['"]0\.0\.0\.0['"]/i,
];

// BAD: explicit localhost binding
const BAD_PATTERNS = [
  /listen\s*\([^)]*['"]127\.0\.0\.1['"]/,
  /listen\s*\([^)]*['"]localhost['"]/i,
];

// NEUTRAL: listen with a port arg only (no host) — Node.js defaults to :: (all interfaces) since v18+
// Only matches numeric literals or process.env.PORT — NOT variable names like 'options' which could contain {host: 'localhost'}
const NO_HOST_LISTEN = /\.listen\s*\(\s*(?:\d+|process\.env\.PORT\b[^,)]*|\{[^}]*\bport\s*:[^}]*\})(?:\s*,\s*[^)]*)?\s*\)/i;

// ENV-VAR based host — could be anything, needs manual review
const ENV_HOST_PATTERN = /process\.env\.(?:HOST|BIND_ADDRESS|SERVER_HOST)/i;

// ---- Helpers ----

/**
 * Check if a line is a comment (should be skipped)
 */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') ||
         trimmed.startsWith('*') ||
         trimmed.startsWith('/*') ||
         trimmed.startsWith('* ');
}

/**
 * Build the list of files to scan for binding patterns.
 * Prioritizes likely server entry points and de-prioritizes framework internals.
 */
function selectFiles(tree) {
  // Priority 1: Direct server/entry files with extensions
  const priority1 = tree.filter(p =>
    /\.(js|ts|mjs|cjs)$/.test(p) &&
    !/(test|spec|__tests__|__mocks__|\.d\.ts|dist\/|build\/|\.min\.)/.test(p) &&
    /^(bin\/|cli\/|src\/server|src\/app|src\/index|src\/main|src\/cli|server\.|app\.|index\.|main\.|start\.)/.test(p)
  );

  // Priority 2: CLI entry points (may lack .js extension, have shebang)
  const priority2 = tree.filter(p =>
    /^bin\//.test(p) &&
    !/(test|spec|__tests__)/.test(p) &&
    !priority1.includes(p)
  );

  // Priority 3: Other files with listen-related names
  const priority3 = tree.filter(p =>
    /\.(js|ts|mjs|cjs)$/.test(p) &&
    !/(test|spec|__tests__|__mocks__|\.d\.ts|dist\/|build\/|\.min\.)/.test(p) &&
    /(server|app|index|main|listen|serve)/.test(p) &&
    !priority1.includes(p) &&
    !priority2.includes(p)
  );

  // Priority 4: Root-level JS files (often entry points)
  const priority4 = tree.filter(p =>
    /^[^/]+\.(js|ts|mjs|cjs)$/.test(p) &&
    !/(test|spec|__tests__|__mocks__|\.d\.ts)/.test(p) &&
    !priority1.includes(p) &&
    !priority2.includes(p) &&
    !priority3.includes(p)
  );

  // Combine — exclude known framework-internal files when user-facing files exist
  // Framework internals (lib/application.js, lib/server.js) are method implementations, not user binding code
  const combined = [...priority1, ...priority2, ...priority3, ...priority4];

  const isFrameworkInternal = (p) =>
    /^lib\/application\./.test(p) ||       // Express: app.listen() method definition
    /^lib\/server\./.test(p);              // Fastify: server.listen() delegation

  const userFiles = combined.filter(p => !isFrameworkInternal(p));

  // If we have user-facing files, scan only those. Otherwise scan everything we found.
  return (userFiles.length > 0 ? userFiles : combined).slice(0, 8);
}

/**
 * Check framework-specific deployment configs and scripts for host binding patterns.
 * Frameworks like Next.js, Nuxt, Astro handle binding internally — no raw listen() calls.
 */
async function checkFrameworkDeployment(tree, files, packageJson) {
  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  const scripts = packageJson?.scripts || {};
  const allScriptText = Object.values(scripts).join(' ');

  const findings = [];

  // ---- 1. Script flags: -H 0.0.0.0, --host 0.0.0.0, --hostname 0.0.0.0 ----
  const FLAG_GOOD = /\s(?:-H|--host|--hostname)\s+['"]0\.0\.0\.0['"]/;
  const FLAG_BAD = /\s(?:-H|--host|--hostname)\s+['"](?:localhost|127\.0\.0\.1)['"]/;

  if (FLAG_GOOD.test(allScriptText)) {
    return { type: 'good', message: 'Framework start script binds to 0.0.0.0', findings: [{ file: 'package.json', line: 0, issue: 'Script flags host as 0.0.0.0' }] };
  }
  if (FLAG_BAD.test(allScriptText)) {
    return { type: 'bad', message: 'Framework start script binds to localhost', findings: [{ file: 'package.json', line: 0, issue: 'Script flags host as localhost' }] };
  }

  // ---- 2. Config file patterns ----
  const CONFIG_FILES = [
    { name: 'next.config', pattern: /next\.config\.(js|mjs|ts)/ },
    { name: 'nuxt.config', pattern: /nuxt\.config\.(ts|js)/ },
    { name: 'astro.config', pattern: /astro\.config\.(mjs|js|ts)/ },
    { name: 'vite.config', pattern: /vite\.config\.(js|ts|mjs)/ },
    { name: 'svelte.config', pattern: /svelte\.config\.(js|ts)/ },
    { name: 'remix.config', pattern: /remix\.config\.(js|ts)/ },
  ];

  for (const { name, pattern } of CONFIG_FILES) {
    const configPath = tree.find(p => pattern.test(p));
    if (!configPath) continue;
    const content = await files.get(configPath);
    if (!content) continue;

    // GOOD: host: '0.0.0.0' in config
    if (/host\s*:\s*['"]0\.0\.0\.0['"]/.test(content)) {
      return { type: 'good', message: `${name} explicitly sets host to 0.0.0.0`, findings: [{ file: configPath, line: 0, issue: 'Config binds to 0.0.0.0' }] };
    }
    // BAD: host: 'localhost' in config
    if (/host\s*:\s*['"](?:localhost|127\.0\.0\.1)['"]/.test(content)) {
      return { type: 'bad', message: `${name} sets host to localhost`, findings: [{ file: configPath, line: 0, issue: 'Config binds to localhost' }] };
    }
  }

  // ---- 3. Known frameworks with safe production defaults ----
  // These frameworks default to 0.0.0.0 in production (no explicit listen needed)
  const safeFrameworks = {
    next: 'Next.js',
    nuxt: 'Nuxt',
    astro: 'Astro',
    '@sveltejs/kit': 'SvelteKit',
    hono: 'Hono',
    remix: 'Remix',
  };
  for (const [pkg, label] of Object.entries(safeFrameworks)) {
    if (deps[pkg]) {
      return { type: 'good', message: `${label} handles host binding internally (defaults to 0.0.0.0 in production)`, findings: [{ file: 'package.json', line: 0, issue: `${label} framework with internal host binding` }] };
    }
  }

  // ---- 4. Vite as dev server (not production) ----
  if (deps.vite && !deps.next && !deps.nuxt && !deps.astro) {
    // Vite alone is a dev tool; production hosting is via adapter
    return { type: 'check-it', message: 'Vite dev server — verify production host binding in deployment config', findings: [] };
  }

  return null; // No framework pattern detected
}

/**
 * Detect if the repo is a pure library with no server capability.
 * Used to return not-applicable more accurately.
 */
function isPureLibrary(repoType, tree, packageJson) {
  // Definitively server-related repo types should NEVER be short-circuited.
  // The classifier correctly identifies servers and frameworks — these always need host binding checks.
  if (repoType === 'server' || repoType === 'framework') return false;
  if (repoType === 'library' || repoType === 'empty') return true;

  // For 'deployable', 'tool', 'unknown': check if it's actually a library in disguise.
  // The classifier often mislabels libraries (React) and simple websites as 'deployable'.

  // Check for server-related dependencies
  const deps = packageJson?.dependencies || {};
  const devDeps = packageJson?.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  const serverDeps = ['express', 'fastify', 'koa', 'hono', '@hono/node-server', 'http-server',
    'polka', 'restify', 'micro', 'connect']; // NOTE: vite/webpack-dev-server are dev tools, not prod servers
  const hasServerDep = serverDeps.some(d => allDeps[d]);

  // Check for framework dependencies — these handle server binding internally
  const frameworkDeps = ['next', 'nuxt', 'astro', '@sveltejs/kit', 'remix', 'hono'];
  const hasFrameworkDep = frameworkDeps.some(d => allDeps[d]);
  // Frameworks are NEVER libraries — they are deployable applications
  if (hasFrameworkDep) return false;

  // Check for actual server entry-point files (not SSR packages or generic index.js deep in packages/)
  const hasServerFile = tree.some(p => {
    if (!/\.(js|ts|mjs|cjs)$/.test(p)) return false;
    if (/(test|spec|__tests__)/.test(p)) return false;
    // Exclude known false positives: React SSR packages, server-side rendering code
    if (/react-server|react-dom\/server|server-side|ssr/.test(p)) return false;
    const name = p.split('/').pop();
    const depth = p.split('/').length;
    // Actual server entry points
    return /^(server|app|listen|start)\.\w+$/.test(name) ||  // server.js, app.js
           (/^(index|main)\.\w+$/.test(name) && depth === 1) || // index.js ONLY at root
           /^bin\//.test(p) ||                                  // bin/ entry points
           /^src\/(server|app)\//.test(p);                      // src/server/, src/app/
  });

  // CLI tools without server deps are not deployable servers
  const toolIndicators = ['nodemon', 'cypress', 'playwright', 'jest', 'mocha', 'ava',
    'eslint', 'prettier', 'webpack', 'rollup', 'parcel', 'babel', 'typescript'];
  const isLikelyTool = repoType === 'tool' ||
    toolIndicators.some(t => packageJson?.name?.includes(t));

  // Keyword-based detection: packages with "library", "component", "ui" keywords and peerDeps are libraries
  const keywords = packageJson?.keywords || [];
  const hasLibraryKeywords = keywords.some(k => /library|component|ui|react|vue|angular|client/.test(k));
  if (hasLibraryKeywords && !hasServerDep) return true;

  // If no server deps and no server files, it's effectively a library
  if (!hasServerDep && !hasServerFile) return true;
  // CLI tools without server deps are not deployable servers
  if (isLikelyTool && !hasServerDep) return true;

  return false;
}

// ---- Main Check ----

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    // Skip pure libraries
    if (isPureLibrary(repoType, tree, packageJson)) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'No server detected — host binding not applicable',
        findings: [],
      };
    }

    const filesToScan = selectFiles(tree);

    let foundGood = false;
    let foundBad = false;
    let foundNoHost = false;
    let foundEnvHost = false;
    const findings = [];
    const seenFindings = new Set(); // deduplication

    function addFinding(file, line, issue) {
      const key = `${file}:${line}:${issue}`;
      if (seenFindings.has(key)) return;
      seenFindings.add(key);
      findings.push({ file, line, issue });
    }

    for (const filePath of filesToScan) {
      const content = await files.get(filePath);
      if (!content) continue;
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip comments and JSDoc
        if (isCommentLine(line)) continue;

        // Skip lines that don't have listen or createServer
        if (!/\.listen\s*\(/.test(line) && !/createServer.*\.listen/.test(line)) continue;

        // Check GOOD patterns
        for (const pattern of GOOD_PATTERNS) {
          if (pattern.test(line)) {
            foundGood = true;
            addFinding(filePath, i + 1, 'Binds to 0.0.0.0');
          }
        }

        // Check BAD patterns
        for (const pattern of BAD_PATTERNS) {
          if (pattern.test(line)) {
            foundBad = true;
            addFinding(filePath, i + 1, 'Binds to localhost only');
          }
        }

        // Check env-var based host
        if (ENV_HOST_PATTERN.test(line)) {
          foundEnvHost = true;
          addFinding(filePath, i + 1, 'Host determined by environment variable');
        }

        // Check no-host listen (e.g., app.listen(3000))
        // Only count if no good/bad/env pattern already matched on this line
        if (!foundGood && !foundBad && !foundEnvHost && NO_HOST_LISTEN.test(line)) {
          // Make sure this isn't already covered by another pattern
          const alreadyMatched = GOOD_PATTERNS.some(p => p.test(line)) ||
                                 BAD_PATTERNS.some(p => p.test(line)) ||
                                 ENV_HOST_PATTERN.test(line) ||
                                 /host\s*:/i.test(line); // object with host property
          if (!alreadyMatched) {
            foundNoHost = true;
            addFinding(filePath, i + 1, 'Listens on port without explicit host (defaults to all interfaces)');
          }
        }
      }
    }

    // Check if the repo has any server-related dependencies
    const allDeps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const serverDeps = ['express', 'fastify', 'koa', 'hono', '@hono/node-server', 'http-server',
      'polka', 'restify', 'micro', 'connect'];
    const hasServerDep = serverDeps.some(d => allDeps[d]);

    // Determine result
    if (foundGood) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: 'Server binds to 0.0.0.0 (all network interfaces)',
        findings,
      };
    }

    if (foundBad) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: 'Server binds to localhost/127.0.0.1 only — must use 0.0.0.0 for cloud deployment',
        findings,
      };
    }

    if (foundEnvHost) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: 'Host binding controlled by environment variable — verify it is set to 0.0.0.0 in production',
        findings,
      };
    }

    if (foundNoHost) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: 'Server listens without explicit host (Node.js defaults to all interfaces since v18+)',
        findings,
      };
    }

    // ---- FRAMEWORK-SPECIFIC DEPLOYMENT CHECK ----
    // Next.js, Nuxt, Astro, SvelteKit, etc. handle binding internally.
    // Check config files and scripts before giving up.
    const fwResult = await checkFrameworkDeployment(tree, files, packageJson);
    if (fwResult) {
      if (fwResult.type === 'good') {
        return { checkId, status: 'pass', confidence: 'medium', message: fwResult.message, findings: fwResult.findings };
      }
      if (fwResult.type === 'bad') {
        return { checkId, status: 'fail', confidence: 'high', message: fwResult.message, findings: fwResult.findings };
      }
      if (fwResult.type === 'check-it') {
        return { checkId, status: 'check-it', confidence: 'medium', message: fwResult.message, findings: fwResult.findings };
      }
    }

    // POST-SCAN FALLBACK: If we scanned files but found NO listen() calls at all,
    // and the repo has no server dependencies, it's not a server — host binding doesn't apply.
    // This catches libraries misclassified as 'deployable' (e.g., React) where isPureLibrary() fails.
    // Server and framework repos are excluded — they ARE server-related even if binding isn't visible.
    if (repoType !== 'server' && repoType !== 'framework' && !hasServerDep && findings.length === 0) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'No server detected — host binding not applicable',
        findings: [],
      };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'Could not determine host binding from scanned files',
      findings: [],
    };

  } catch (err) {
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error during host-binding check: ${err.message}`,
      findings: [],
    };
  }
}
