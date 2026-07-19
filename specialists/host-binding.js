export const checkId = 'host-binding';
export const name = 'Host Binding (0.0.0.0)';
export const appliesTo = ['deployable', 'server', 'framework'];

const SKIP_PATH = /(?:^|\/)node_modules\/|(?:^|\/)dist\/|(?:^|\/)build\/|(?:^|\/)coverage\/|(?:^|\/)test\/|(?:^|\/)tests\/|(?:^|\/)__tests__\/|(?:^|\/)fixtures\/|(?:^|\/)playground\/|\.d\.ts$|\.min\.js$/;

function isRelevantPath(p) {
  return !SKIP_PATH.test(p);
}

function isBuildToolOrNonServerFramework(packageJson, tree) {
  if (!packageJson) return false;
  const name = (packageJson.name || '').toLowerCase();
  const keywords = (packageJson.keywords || []).map(k => k.toLowerCase());
  const allText = [name, ...keywords].join(' ');

  const buildIndicators = [
    'webpack', 'rollup', 'babel', 'turborepo', 'turbo', 'lerna', 'nx',
    'esbuild', 'parcel', 'bundler', 'compiler', 'transpiler',
    'build-tool', 'build-system', 'monorepo-tool', 'task-runner'
  ];
  if (buildIndicators.some(i => allText.includes(i))) return true;

  const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const hasServerDep = [
    'express', 'fastify', 'koa', 'hono', '@hono/node-server', 'http-server',
    'polka', 'restify', 'micro', 'connect', 'next', 'nuxt', 'astro', 'remix',
    'h3', 'nitropack', 'listhen'
  ].some(d => deps[d]);

  if (!hasServerDep && packageJson.bin) {
    const hasServerFile = tree.some(p =>
      isRelevantPath(p) &&
      /(?:^|\/)server\.|(?:^|\/)app\.|(?:^|\/)listen\./.test(p)
    );
    if (!hasServerFile) {
      const toolIndicators = ['cli', 'build', 'bundle', 'dev', 'tool', 'plugin', 'loader'];
      if (toolIndicators.some(i => allText.includes(i))) return true;
    }
  }

  const keywordsOnly = packageJson.keywords || [];
  if (
    keywordsOnly.some(k => /^(?:library|component|ui|client|browser)$/.test(k)) &&
    !hasServerDep
  ) {
    return true;
  }

  return false;
}

function hasServerSignals(tree, packageJson) {
  const infraBase = new Set([
    'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'fly.toml',
    'railway.toml', 'render.yaml', 'Procfile', 'wrangler.toml', 'netlify.toml',
    'vercel.json'
  ]);
  const hasInfra = tree.some(p => {
    if (!isRelevantPath(p)) return false;
    const base = p.split('/').pop();
    return infraBase.has(base) || infraBase.has(p);
  });
  if (hasInfra) return true;

  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };

  const frameworkOrServerDeps = new Set([
    'next', 'nuxt', 'astro', 'remix', 'hono', 'h3', 'nitropack', 'listhen',
    'express', 'fastify', 'koa', '@hono/node-server', 'http-server',
    'polka', 'restify', 'micro', 'connect'
  ]);
  if (Object.keys(deps).some(d => frameworkOrServerDeps.has(d))) return true;

  const scripts = Object.values(packageJson?.scripts || {}).join(' ');
  if (
    /\b(?:next|nuxt|astro|remix|wrangler|serve|start:prod|start:production|dev:host)\b/.test(scripts) ||
    /(?:-H|--host|--hostname)\b/.test(scripts) ||
    /\b(?:HOST|BIND_ADDRESS|SERVER_HOST)\s*=/.test(scripts)
  ) return true;

  const configPatterns = [
    /(?:^|\/)next\.config\./,
    /(?:^|\/)nuxt\.config\./,
    /(?:^|\/)astro\.config\./,
    /(?:^|\/)remix\.config\./,
    /(?:^|\/)svelte\.config\./,
    /(?:^|\/)nitro\.config\./,
    /(?:^|\/)wrangler\.toml/,
    /(?:^|\/)fly\.toml/,
    /(?:^|\/)railway\.toml/,
    /(?:^|\/)render\.yaml/,
    /(?:^|\/)netlify\.toml/,
    /(?:^|\/)vercel\.json/,
  ];
  if (tree.some(p => isRelevantPath(p) && configPatterns.some(rx => rx.test(p)))) return true;

  const hasServerFile = tree.some(p => {
    if (!isRelevantPath(p) || !/\.(js|ts|mjs|cjs)$/.test(p)) return false;
    if (/(test|spec|__tests__)/.test(p)) return false;
    const name = p.split('/').pop();
    const depth = p.split('/').length;
    return /^(server|app|listen|start|main|entry|bootstrap)\.\w+$/.test(name) ||
           (/^(index)\.\w+$/.test(name) && depth === 1) ||
           /^bin\/(www|server|start|listen|app)\b/.test(p) ||
           /(?:^|\/)src\/(?:server|app|listen|start|main)\.\w+$/.test(p) ||
           /(?:^|\/)apps?\/.+\/(?:server|app|listen|start|main|entry|bootstrap)\.\w+$/.test(p);
  });
  if (hasServerFile) return true;

  if (tree.some(p => /(?:^|\/)Dockerfile(?:\.\w+)?$/.test(p) || /(?:^|\/)docker-compose/.test(p))) return true;

  return false;
}

function selectFiles(tree) {
  const codeExt = /\.(?:js|ts|mjs|cjs)$/;
  const candidates = [];

  function add(p, pri) {
    if (!isRelevantPath(p)) return;
    if (candidates.some(c => c.path === p)) return;
    candidates.push({ path: p, priority: pri });
  }

  tree.forEach(p => {
    if (/^(?:docker-compose|Dockerfile)/.test(p) || /\.dockerfile$/i.test(p) ||
        /fly\.toml$|railway\.toml$|render\.yaml$|wrangler\.toml$|netlify\.toml$|vercel\.json$/.test(p) ||
        /^\.env(?!\.example|\.test)/.test(p)) {
      add(p, 1);
    }
  });

  tree.forEach(p => {
    if (/(?:^|\/)next\.config\.|(?:^|\/)nuxt\.config\.|(?:^|\/)astro\.config\.|(?:^|\/)remix\.config\.|(?:^|\/)svelte\.config\.|(?:^|\/)vite\.config\.|(?:^|\/)nitro\.config\./.test(p)) {
      add(p, 2);
    }
  });

  tree.forEach(p => {
    if (/^[^/]+\.(?:js|ts|mjs|cjs)$/.test(p) && /^(?:server|app|index|main|listen|start|entry|bootstrap)\./.test(p)) {
      add(p, 3);
    }
  });

  tree.forEach(p => {
    if (!codeExt.test(p)) return;
    const name = p.split('/').pop();
    if (/^(?:server|app|listen|start|main|index|entry|bootstrap)\./.test(name)) {
      add(p, 4);
    } else if (/(?:^|\/)src\/(?:server|app|index|main|listen|start)\./.test(p)) {
      add(p, 4);
    } else if (/(?:^|\/)bin\//.test(p)) {
      add(p, 4);
    }
  });

  tree.forEach(p => {
    if (!codeExt.test(p)) return;
    if (/(?:^|\/)apps?\/.+\/(?:server|app|listen|start|main|index|entry|bootstrap)\./.test(p)) {
      add(p, 5);
    } else if (/(?:^|\/)packages?\/.+\/(?:server|app|listen|start|main|index|entry|bootstrap)\./.test(p)) {
      add(p, 6);
    }
  });

  tree.forEach(p => {
    if (!codeExt.test(p)) return;
    const name = p.split('/').pop();
    if (/(?:server|app|listen|start|main|index|entry|bootstrap|application|express|fastify)/.test(name)) {
      add(p, 7);
    }
  });

  tree.forEach(p => {
    if (/^[^/]+\.(?:js|ts|mjs|cjs)$/.test(p)) {
      add(p, 8);
    }
  });

  tree.forEach(p => {
    if (!codeExt.test(p)) return;
    if (/(?:^|\/)examples\/|(?:^|\/)playground\/|(?:^|\/)docs\//.test(p)) {
      add(p, 9);
    }
  });

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.slice(0, 20).map(c => c.path);
}

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('* ');
}

function checkFrameworkDefaults(tree, packageJson) {
  const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
  const findings = [];

  const safeDepLabels = {
    next: 'Next.js',
    nuxt: 'Nuxt',
    astro: 'Astro',
    hono: 'Hono',
    remix: 'Remix',
    h3: 'H3',
    nitropack: 'Nitro',
  };
  for (const [pkg, label] of Object.entries(safeDepLabels)) {
    if (deps[pkg]) {
      findings.push({ file: 'package.json', line: 0, issue: `${label} framework detected` });
      return { confidence: 'medium', message: `${label} handles host binding internally (defaults to 0.0.0.0 in production)`, findings };
    }
  }

  const configMappings = [
    { rx: /(?:^|\/)next\.config\./, label: 'Next.js' },
    { rx: /(?:^|\/)nuxt\.config\./, label: 'Nuxt' },
    { rx: /(?:^|\/)astro\.config\./, label: 'Astro' },
    { rx: /(?:^|\/)svelte\.config\./, label: 'SvelteKit' },
    { rx: /(?:^|\/)remix\.config\./, label: 'Remix' },
    { rx: /(?:^|\/)nitro\.config\./, label: 'Nitro' },
  ];
  for (const { rx, label } of configMappings) {
    const path = tree.find(p => isRelevantPath(p) && rx.test(p));
    if (path) {
      findings.push({ file: path, line: 0, issue: `${label} config detected` });
      return { confidence: 'medium', message: `${label} handles host binding internally (defaults to 0.0.0.0 in production)`, findings };
    }
  }

  return null;
}

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    if (isBuildToolOrNonServerFramework(packageJson, tree)) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Build tool / compiler detected — host binding not applicable',
        findings: [],
      };
    }

    if (!hasServerSignals(tree, packageJson)) {
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
    let foundEnvHost = false;
    let foundNoHost = false;
    const findings = [];
    const seen = new Set();

    function addFinding(file, line, issue) {
      const key = `${file}:${line}:${issue}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ file, line, issue });
    }

    const IPV4_STRING = /['"`]((?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))['"`]/;

    const scripts = packageJson?.scripts || {};
    for (const [scriptName, cmd] of Object.entries(scripts)) {
      if (/(?:-H|--host|--hostname)\s+['"]?0\.0\.0\.0['"]?\b/.test(cmd)) {
        foundGood = true;
        addFinding('package.json', 0, `Script "${scriptName}" flags host as 0.0.0.0`);
      } else if (/(?:-H|--host|--hostname)\s+['"]?(?:localhost|127\.0\.0\.1)['"]?\b/.test(cmd)) {
        foundBad = true;
        addFinding('package.json', 0, `Script "${scriptName}" flags host as localhost`);
      } else {
        const m = cmd.match(/(?:-H|--host|--hostname)\s+['"]?((?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))['"]?\b/);
        if (m) {
          foundBad = true;
          addFinding('package.json', 0, `Script "${scriptName}" flags host as specific IP ${m[1]}`);
        }
      }

      if (/\bHOST\s*=\s*['"]?0\.0\.0\.0['"]?\b/.test(cmd) || /\bBIND_ADDRESS\s*=\s*['"]?0\.0\.0\.0['"]?\b/.test(cmd)) {
        foundGood = true;
        addFinding('package.json', 0, `Script "${scriptName}" sets HOST to 0.0.0.0`);
      } else if (/\bHOST\s*=\s*['"]?(?:localhost|127\.0\.0\.1)['"]?\b/.test(cmd)) {
        foundBad = true;
        addFinding('package.json', 0, `Script "${scriptName}" sets HOST to localhost`);
      } else {
        const m = cmd.match(/\bHOST\s*=\s*['"]?((?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))['"]?\b/);
        if (m) {
          foundBad = true;
          addFinding('package.json', 0, `Script "${scriptName}" sets HOST to specific IP ${m[1]}`);
        }
      }
    }

    for (const filePath of filesToScan) {
      const content = await files.get(filePath);
      if (!content) continue;
      const lines = content.split('\n');

      const isDocker = filePath === 'Dockerfile' || filePath.startsWith('docker-compose') || /\.dockerfile$/i.test(filePath);
      const isEnv = /^\.env/.test(filePath) && !/\.env\.example$/.test(filePath) && !/\.env\.test$/.test(filePath);
      const isConfig = /\.config\.|\.toml$|\.yaml$|\.yml$|\.json$/.test(filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isCommentLine(line)) continue;

        if (isDocker) {
          if (/CMD|ENTRYPOINT|ENV/i.test(line)) {
            if (/['"]0\.0\.0\.0['"]/.test(line) || /\bHOST\s*=\s*0\.0\.0\.0\b/.test(line)) {
              foundGood = true;
              addFinding(filePath, i + 1, 'Docker config binds to 0.0.0.0');
            } else if (/['"]localhost['"]|['"]127\.0\.0\.1['"]/.test(line) || /\bHOST\s*=\s*localhost\b/.test(line)) {
              foundBad = true;
              addFinding(filePath, i + 1, 'Docker config binds to localhost');
            } else {
              const m = line.match(IPV4_STRING);
              if (m) {
                const ip = m[1];
                if (ip !== '0.0.0.0' && ip !== '127.0.0.1') {
                  foundBad = true;
                  addFinding(filePath, i + 1, `Docker config binds to specific IP ${ip}`);
                }
              }
            }
          }
          continue;
        }

        if (isEnv) {
          if (/^(?:HOST|BIND_ADDRESS)\s*=\s*0\.0\.0\.0/.test(line)) {
            foundGood = true;
            addFinding(filePath, i + 1, 'Env file sets host to 0.0.0.0');
          } else if (/^(?:HOST|BIND_ADDRESS)\s*=\s*localhost/.test(line)) {
            foundBad = true;
            addFinding(filePath, i + 1, 'Env file sets HOST to localhost');
          } else {
            const m = line.match(/^(?:HOST|BIND_ADDRESS)\s*=\s*((?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))/);
            if (m) {
              foundBad = true;
              addFinding(filePath, i + 1, `Env file sets HOST to specific IP ${m[1]}`);
            }
          }
          continue;
        }

        if (isConfig) {
          if (/["']?host["']?\s*[:=]\s*['"]?0\.0\.0\.0['"]?/i.test(line)) {
            foundGood = true;
            addFinding(filePath, i + 1, 'Config sets host to 0.0.0.0');
          } else if (/["']?host["']?\s*[:=]\s*['"]?(?:localhost|127\.0\.0\.1)['"]?/i.test(line)) {
            foundBad = true;
            addFinding(filePath, i + 1, 'Config sets host to localhost');
          } else {
            const m = line.match(/["']?host["']?\s*[:=]\s*['"]?((?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))['"]?/i);
            if (m) {
              foundBad = true;
              addFinding(filePath, i + 1, `Config binds to specific IP ${m[1]} — use 0.0.0.0 for cloud deployment`);
            }
          }
          if (/\bHOST\s*:\s*0\.0\.0\.0/.test(line) || /-\s*HOST\s*=\s*0\.0\.0\.0/.test(line)) {
            foundGood = true;
            addFinding(filePath, i + 1, 'Config sets HOST to 0.0.0.0');
          } else if (/\bHOST\s*:\s*(?:localhost|127\.0\.0\.1)/.test(line) || /-\s*HOST\s*=\s*(?:localhost|127\.0\.0\.1)/.test(line)) {
            foundBad = true;
            addFinding(filePath, i + 1, 'Config sets HOST to localhost');
          } else {
            const m = line.match(/\bHOST\s*:\s*((?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))/);
            if (m) {
              foundBad = true;
              addFinding(filePath, i + 1, `Config sets HOST to specific IP ${m[1]} — use 0.0.0.0 for cloud deployment`);
            }
          }
          continue;
        }

        const hasListen = /\.listen\s*\(/.test(line);
        const hasBunServe = /Bun\.serve\s*\(/.test(line);
        const hasDenoServe = /Deno\.(?:serve|listen)\s*\(/.test(line);
        const hasCreateServer = /createServer\s*\(/.test(line);

        if (!hasListen && !hasBunServe && !hasDenoServe && !hasCreateServer) continue;

        const hasGoodLiteral = /['"`]0\.0\.0\.0['"`]|['"`]::['"`]/.test(line);
        const hasBadLiteral = /['"`]127\.0\.0\.1['"`]|['"`]localhost['"`]/i.test(line);

        if (hasGoodLiteral) {
          foundGood = true;
          addFinding(filePath, i + 1, 'Explicitly binds to 0.0.0.0');
          continue;
        }
        if (hasBadLiteral) {
          foundBad = true;
          addFinding(filePath, i + 1, 'Explicitly binds to localhost');
          continue;
        }

        const specificIpMatch = line.match(IPV4_STRING);
        if (specificIpMatch) {
          const ip = specificIpMatch[1];
          foundBad = true;
          addFinding(filePath, i + 1, `Binds to specific IP ${ip} — use 0.0.0.0 for cloud deployment`);
          continue;
        }

        const hasEnvHost = /process\.env\.(?:HOST|BIND_ADDRESS|SERVER_HOST)/.test(line);
        if (hasEnvHost) {
          foundEnvHost = true;
          addFinding(filePath, i + 1, 'Host determined by environment variable');
          continue;
        }

        const hasHostKey = /\b(?:host|hostname)\s*:/.test(line);
        if (hasHostKey) {
          foundEnvHost = true;
          addFinding(filePath, i + 1, 'Host set via configuration object (value unclear)');
          continue;
        }

        if (hasListen || hasBunServe || hasDenoServe) {
          foundNoHost = true;
          addFinding(filePath, i + 1, 'Listens without explicit host (defaults to all interfaces)');
        }
      }
    }

    if (foundBad) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: 'Server binds to localhost/127.0.0.1 or a specific IP — must use 0.0.0.0 for cloud deployment',
        findings,
      };
    }

    if (foundGood) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: 'Server binds to 0.0.0.0 (all network interfaces)',
        findings,
      };
    }

    if (foundEnvHost) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: 'Host binding controlled by environment variable or config — verify it is set to 0.0.0.0 in production',
        findings,
      };
    }

    if (foundNoHost) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: 'Server listens without explicit host (Node.js/Bun/Deno defaults to all interfaces)',
        findings,
      };
    }

    const fwResult = checkFrameworkDefaults(tree, packageJson);
    if (fwResult) {
      return {
        checkId,
        status: 'pass',
        confidence: fwResult.confidence,
        message: fwResult.message,
        findings: fwResult.findings,
      };
    }

    if (tree.some(p => isRelevantPath(p) && /(?:^|\/)wrangler\.toml/.test(p))) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: 'Cloudflare Workers deployment detected — host binding handled by platform',
        findings: [{ file: 'wrangler.toml', line: 0, issue: 'Platform-managed host binding' }],
      };
    }

    if (tree.some(p => isRelevantPath(p) && /(?:^|\/)netlify\.toml/.test(p))) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: 'Netlify deployment detected — host binding handled by platform',
        findings: [{ file: 'netlify.toml', line: 0, issue: 'Platform-managed host binding' }],
      };
    }

    if (tree.some(p => isRelevantPath(p) && /(?:^|\/)vercel\.json/.test(p))) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: 'Vercel deployment detected — host binding handled by platform',
        findings: [{ file: 'vercel.json', line: 0, issue: 'Platform-managed host binding' }],
      };
    }

    const hasInfra = tree.some(p =>
      isRelevantPath(p) &&
      (/(?:^|\/)Dockerfile(?:\.\w+)?$/.test(p) || /(?:^|\/)docker-compose/.test(p) || /fly\.toml$|railway\.toml$|render\.yaml$/.test(p))
    );
    if (hasInfra) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: 'Containerized/cloud deployment detected — no localhost binding found',
        findings: [{ file: 'Dockerfile', line: 0, issue: 'Infrastructure present; no localhost restriction detected' }],
      };
    }

    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const rawServerDeps = new Set([
      'express', 'fastify', 'koa', 'hono', '@hono/node-server', 'http-server',
      'polka', 'restify', 'micro', 'connect', 'h3', 'nitropack', 'listhen'
    ]);
    if (Object.keys(deps).some(d => rawServerDeps.has(d))) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: 'Server runtime detected without explicit localhost binding — defaults to all interfaces',
        findings: [{ file: 'package.json', line: 0, issue: 'Server dependency present; no localhost restriction found' }],
      };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'Could not determine host binding from scanned files',
      findings: [{ file: 'package.json', line: 0, issue: 'Server signals detected but host binding could not be verified from available files' }],
    };
  } catch (err) {
    console.error('host-binding check error:', err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error during host-binding check: ${err.message}`,
      findings: [],
    };
  }
}