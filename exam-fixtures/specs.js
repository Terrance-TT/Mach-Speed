/**
 * exam-fixtures/specs.js — fixture specifications for the Mach-Speed exam.
 *
 * Two families, all owned by the fake org `mach-speed-exam` (can never collide
 * with a real GitHub owner):
 *
 *   kind: 'mutant'  — a healthy mini-repo with ONE injected known fault; the
 *                     targeted specialist MUST flag it (fail | check-it).
 *   kind: 'control' — a provably-correct mini-repo; every listed check MUST
 *                     stay inside its allowed status set (pass | not-applicable).
 *
 * Fixture content was crafted against the ACTUAL detection logic of the 12
 * specialists in ms-work/specialists (read line-by-line), not assumed logic.
 * See REPORT.md for the per-fixture rationale and the specialist quirks found.
 *
 * Module rules: pure data + pure builders. Importing this file performs no I/O.
 */

/* --------------------------------------------------------------------------
 * Shared content builders (pure functions — no I/O)
 * ------------------------------------------------------------------------ */

const pkg = (obj) => JSON.stringify(obj, null, 2) + '\n';

/** Minimal-but-plausible npm v3 lockfile mirroring the given dep maps. */
function npmLock(name, version, prodDeps, devDeps = {}) {
  const packages = {
    '': {
      name,
      version,
      ...(Object.keys(prodDeps).length ? { dependencies: { ...prodDeps } } : {}),
      ...(Object.keys(devDeps).length ? { devDependencies: { ...devDeps } } : {}),
    },
  };
  let n = 0;
  for (const [dep, range] of [...Object.entries(prodDeps), ...Object.entries(devDeps)]) {
    const v = range.replace(/^[^0-9]*/, '');
    packages[`node_modules/${dep}`] = {
      version: v,
      resolved: `https://registry.npmjs.org/${dep}/-/${dep.split('/').pop()}-${v}.tgz`,
      integrity: `sha512-${Buffer.from(`${dep}@${v}`).toString('base64')}${'qkJ7'.repeat(8)}${n++}==`,
    };
  }
  return pkg({ name, version, lockfileVersion: 3, requires: true, packages });
}

/** Standard deployable-app package.json (mutate via options per fixture). */
function appPkg({ name, scripts, deps, devDeps = { esbuild: '^0.21.5' }, engines = true }) {
  const base = {
    name,
    version: '1.4.2',
    private: true,
    description: 'Acme shop API — small demo service',
    scripts,
    dependencies: deps,
    devDependencies: devDeps,
  };
  if (engines) base.engines = { node: '>=20' };
  return pkg(base);
}

const STD_SCRIPTS = {
  start: 'node server.js',
  build: 'esbuild server.js --bundle --platform=node --outfile=dist/server.js',
};

const STD_DEPS = { cors: '^2.8.5', express: '^4.19.2' };

const DOCKERFILE_NODE = `FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]
`;

/** Variant that pins NO node version anywhere (FROM alpine, apk-provided node). */
const DOCKERFILE_ALPINE = `FROM alpine:3.20
RUN apk add --no-cache nodejs npm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "server.js"]
`;

/** Variant for a repo with no lockfile to copy. */
const DOCKERFILE_NO_LOCK = `FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "server.js"]
`;

const PUBLIC_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>acme shop</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <h1>acme shop</h1>
  <p>Static landing page for the demo storefront.</p>
</body>
</html>
`;

/** Healthy deployable server: env port, 0.0.0.0 bind, /health, cors, static. */
const SERVER_HEALTHY = `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));

const items = [{ id: 1, name: 'widget' }];

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/items', (req, res) => {
  res.json({ items });
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('acme shop api listening on port ' + PORT);
});
`;

/** All files shared by the "healthy deployable" mutants (minus lockfile where noted). */
function healthyDeployableFiles({ name, serverJs, lock = true, dockerfile = DOCKERFILE_NODE, deps = STD_DEPS }) {
  const files = {
    'package.json': appPkg({ name, scripts: STD_SCRIPTS, deps }),
    'server.js': serverJs,
    'public/index.html': PUBLIC_INDEX_HTML,
    Dockerfile: dockerfile,
  };
  if (lock) files['package-lock.json'] = npmLock(name, '1.4.2', deps, { esbuild: '^0.21.5' });
  return files;
}

/* --------------------------------------------------------------------------
 * MUTANTS — one injected fault each, everything else textbook-healthy.
 * ------------------------------------------------------------------------ */

// -- dynamic-port: app.listen(3000) hardcoded, no process.env.PORT anywhere --
const M_DYNAMIC_PORT = {
  slug: 'mach-speed-exam/mutant-dynamic-port-hardcoded',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Express deployable listens on hardcoded port 3000 with zero process.env.PORT usage — dynamic-port must fail it.',
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));

const items = [{ id: 1, name: 'widget' }];

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/items', (req, res) => {
  res.json({ items });
});

app.listen(3000, '0.0.0.0', () => {
  console.log('acme shop api listening on port 3000');
});
`,
  }),
  expect: { 'dynamic-port': ['fail', 'check-it'] },
};

// -- host-binding: binds to 127.0.0.1 only (unreachable from outside the container) --
const M_HOST_BINDING = {
  slug: 'mach-speed-exam/mutant-host-binding-localhost',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Express deployable binds to 127.0.0.1 instead of 0.0.0.0 — host-binding must fail it (port itself is dynamic).',
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));

const items = [{ id: 1, name: 'widget' }];

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/items', (req, res) => {
  res.json({ items });
});

const PORT = process.env.PORT;
app.listen(PORT, '127.0.0.1', () => {
  console.log('acme shop api listening on 127.0.0.1:' + PORT);
});
`,
  }),
  expect: { 'host-binding': ['fail', 'check-it'] },
};

// -- start-script: deployable server with no scripts.start / serve / start:prod --
const M_START_SCRIPT = {
  slug: 'mach-speed-exam/mutant-start-script-missing',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Express deployable whose package.json has only dev/build scripts — no start, serve or start:prod. start-script must fail it.',
  files: (() => {
    const deps = { ...STD_DEPS };
    return {
      'package.json': appPkg({
        name: 'acme-shop-api',
        scripts: {
          dev: 'node --watch server.js',
          build: 'esbuild server.js --bundle --platform=node --outfile=dist/server.js',
        },
        deps,
      }),
      'server.js': SERVER_HEALTHY,
      'public/index.html': PUBLIC_INDEX_HTML,
      Dockerfile: DOCKERFILE_NODE,
      'package-lock.json': npmLock('acme-shop-api', '1.4.2', deps, { esbuild: '^0.21.5' }),
    };
  })(),
  expect: { 'start-script': ['fail', 'check-it'] },
};

// -- node-version: no engines, no volta, no .nvmrc/.node-version/.tool-versions,
//    Dockerfile builds on alpine with apk-provided node (version unpinned) --
const M_NODE_VERSION = {
  slug: 'mach-speed-exam/mutant-node-version-unspecified',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Deployable that pins Node nowhere: no engines, no version files, Dockerfile uses alpine + apk nodejs. node-version must flag it.',
  files: (() => {
    const deps = { ...STD_DEPS };
    return {
      'package.json': appPkg({ name: 'acme-shop-api', scripts: STD_SCRIPTS, deps, engines: false }),
      'server.js': SERVER_HEALTHY,
      'public/index.html': PUBLIC_INDEX_HTML,
      Dockerfile: DOCKERFILE_ALPINE,
      'package-lock.json': npmLock('acme-shop-api', '1.4.2', deps, { esbuild: '^0.21.5' }),
    };
  })(),
  expect: { 'node-version': ['fail', 'check-it'] },
};

// -- build-step: TypeScript library (tsc devDep + tsconfig) with NO build script --
const M_BUILD_STEP = {
  slug: 'mach-speed-exam/mutant-build-step-missing',
  kind: 'mutant',
  expectedType: 'library',
  note: 'TypeScript library shipping dist/ output (main: dist/index.js) with a typescript devDependency and tsconfig but no scripts.build — build-step must fail it.',
  files: {
    'package.json': pkg({
      name: 'fleet-format',
      version: '2.1.0',
      description: 'Tiny formatting helpers for logistics data',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      exports: { '.': './dist/index.js' },
      files: ['dist'],
      scripts: { test: 'node --test' },
      engines: { node: '>=20' },
      keywords: ['library', 'utility'],
      license: 'MIT',
      devDependencies: { typescript: '^5.5.4' },
    }),
    'tsconfig.json': pkg({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        declaration: true,
        skipLibCheck: true,
      },
      include: ['src'],
    }),
    'src/index.ts': `/** fleet-format — tiny formatting helpers for logistics data. */

export function formatWeight(kilograms: number): string {
  return kilograms >= 1000
    ? (kilograms / 1000).toFixed(2) + ' t'
    : kilograms.toFixed(1) + ' kg';
}

export function formatRouteCode(depot: string, seq: number): string {
  return depot.toUpperCase() + '-' + String(seq).padStart(4, '0');
}
`,
    'README.md': '# fleet-format\n\nTiny formatting helpers for logistics data. Build output lands in `dist/`.\n',
    'package-lock.json': npmLock('fleet-format', '2.1.0', {}, { typescript: '^5.5.4' }),
  },
  expect: { 'build-step': ['fail', 'check-it'] },
};

// -- static-files: deployable WITH public/ assets but nothing serves them --
const M_STATIC_FILES = {
  slug: 'mach-speed-exam/mutant-static-files-unserved',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Express deployable ships public/ assets (index.html, app.css) but never serves them — no express.static, no serve-static, no mount. static-files must flag it.',
  files: (() => {
    const deps = { ...STD_DEPS };
    return {
      'package.json': appPkg({ name: 'acme-shop-api', scripts: STD_SCRIPTS, deps }),
      'server.js': `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

const items = [{ id: 1, name: 'widget' }];

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/items', (req, res) => {
  res.json({ items });
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('acme shop api listening on port ' + PORT);
});
`,
      'public/index.html': PUBLIC_INDEX_HTML,
      'public/app.css': 'body { font-family: system-ui, sans-serif; margin: 2rem; }\nh1 { color: #1a4f8a; }\n',
      Dockerfile: DOCKERFILE_NODE,
      'package-lock.json': npmLock('acme-shop-api', '1.4.2', deps, { esbuild: '^0.21.5' }),
    };
  })(),
  expect: { 'static-files': ['fail', 'check-it'] },
};

// -- health-check: server exposes only business routes, no /health anywhere --
const M_HEALTH_CHECK = {
  slug: 'mach-speed-exam/mutant-health-check-missing',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Express deployable with only business routes (/, /api/items) — no /health, /healthz, /ready, /alive or /status endpoint. health-check must flag it.',
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));

const items = [{ id: 1, name: 'widget' }];

app.get('/', (req, res) => {
  res.json({ service: 'acme-shop-api' });
});

app.get('/api/items', (req, res) => {
  res.json({ items });
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('acme shop api listening on port ' + PORT);
});
`,
  }),
  expect: { 'health-check': ['fail', 'check-it'] },
};

// -- cors: API server with ZERO CORS configuration (the specialist only detects
//    presence of CORS config; a wide-open cors() call would actually PASS it) --
const M_CORS = {
  slug: 'mach-speed-exam/mutant-cors-unconfigured',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Express API server with no CORS handling at all — no cors dependency, no cors() call, no access-control-allow-origin header. cors must flag it (check-it).',
  files: (() => {
    const deps = { express: '^4.19.2' };
    return {
      'package.json': appPkg({ name: 'acme-shop-api', scripts: STD_SCRIPTS, deps }),
      'server.js': `const express = require('express');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const items = [{ id: 1, name: 'widget' }];

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/items', (req, res) => {
  res.json({ items });
});

app.post('/api/items', (req, res) => {
  items.push(req.body);
  res.status(201).json(req.body);
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('acme shop api listening on port ' + PORT);
});
`,
      'public/index.html': PUBLIC_INDEX_HTML,
      Dockerfile: DOCKERFILE_NODE,
      'package-lock.json': npmLock('acme-shop-api', '1.4.2', deps, { esbuild: '^0.21.5' }),
    };
  })(),
  expect: { cors: ['fail', 'check-it'] },
};

// -- env-vars: CLI tool with hardcoded config and ZERO environment reads anywhere --
const M_ENV_VARS = {
  slug: 'mach-speed-exam/mutant-env-vars-hardcoded',
  kind: 'mutant',
  expectedType: 'tool',
  note: 'CLI tool whose deploy-API config (base URL, region, timeout) is hardcoded in lib/config.js with zero process.env/import.meta.env reads in any source file — env-vars must flag it (check-it).',
  files: {
    'package.json': pkg({
      name: 'shiptool',
      version: '0.9.1',
      description: 'CLI for shipping release manifests to the internal deploy API',
      bin: { shiptool: 'bin/shiptool.js' },
      scripts: {
        start: 'node bin/shiptool.js',
        build: 'esbuild bin/shiptool.js --bundle --platform=node --outfile=dist/shiptool.js',
      },
      engines: { node: '>=20' },
      keywords: ['cli', 'deploy'],
      license: 'MIT',
      dependencies: { commander: '^12.1.0' },
      devDependencies: { esbuild: '^0.21.5' },
    }),
    'bin/shiptool.js': `#!/usr/bin/env node
const { program } = require('commander');
const config = require('../lib/config');
const { shipManifest } = require('../lib/runner');

program
  .name('shiptool')
  .description('Ship a release manifest to the internal deploy API')
  .argument('<manifest>', 'path to the release manifest JSON file')
  .option('--dry-run', 'print the payload without sending it')
  .action(async (manifestPath, options) => {
    const result = await shipManifest(manifestPath, config, { dryRun: !!options.dryRun });
    console.log(result.message);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
`,
    'lib/config.js': `// Deploy API configuration.
module.exports = {
  API_BASE_URL: 'https://deploy.internal.acme-corp.io',
  REGION: 'us-east-1',
  TIMEOUT_MS: 8000,
};
`,
    'lib/runner.js': `const fs = require('node:fs');

async function shipManifest(manifestPath, config, { dryRun } = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const payload = { manifest, region: config.REGION };
  if (dryRun) {
    return { message: JSON.stringify(payload, null, 2) };
  }
  const res = await fetch(config.API_BASE_URL + '/v1/manifests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error('deploy API returned HTTP ' + res.status);
  }
  return { message: 'manifest shipped to ' + config.REGION };
}

module.exports = { shipManifest };
`,
    'README.md': '# shiptool\n\nCLI for shipping release manifests to the internal deploy API.\n',
    'package-lock.json': npmLock('shiptool', '0.9.1', { commander: '^12.1.0' }, { esbuild: '^0.21.5' }),
  },
  expect: { 'env-vars': ['fail', 'check-it'] },
};

// -- database-config: pg dependency + hardcoded connection string WITH credentials --
// (URL entropy is deliberately low — 3.20 bits — so the secrets specialist does NOT
//  flag it; only database-config should fire. Verified numerically.)
const M_DATABASE_CONFIG = {
  slug: 'mach-speed-exam/mutant-database-config-hardcoded',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Express deployable with a pg Pool whose connection string (with credentials) is hardcoded in db.js and zero env-based DB config — database-config must fail it.',
  files: (() => {
    const deps = { ...STD_DEPS, pg: '^8.12.0' };
    const files = healthyDeployableFiles({
      name: 'acme-shop-api',
      deps,
      serverJs: `const express = require('express');
const cors = require('cors');
const { listItems } = require('./db');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/items', async (req, res) => {
  const items = await listItems();
  res.json({ items });
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('acme shop api listening on port ' + PORT);
});
`,
    });
    files['db.js'] = `const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:postgres@db.internal.acme:5432/shopdb',
});

async function listItems() {
  const { rows } = await pool.query('SELECT id, name FROM items ORDER BY id');
  return rows;
}

module.exports = { pool, listItems };
`;
    return files;
  })(),
  expect: { 'database-config': ['fail', 'check-it'] },
};

// -- lockfile: package.json present, NO lockfile of any kind --
const M_LOCKFILE = {
  slug: 'mach-speed-exam/mutant-lockfile-missing',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Healthy Express deployable missing any lockfile (no package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock) — lockfile must fail it.',
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: SERVER_HEALTHY,
    lock: false,
    dockerfile: DOCKERFILE_NO_LOCK,
  }),
  expect: { lockfile: ['fail', 'check-it'] },
};

// -- secrets: AWS-style hardcoded key literals (entropy-verified > 3.5 bits) --
const M_SECRETS = {
  slug: 'mach-speed-exam/mutant-secrets-hardcoded-key',
  kind: 'mutant',
  expectedType: 'deployable',
  note: 'Healthy Express deployable plus config.js with hardcoded AWS-style credentials (apiKey/secret literals, high entropy) — secrets must fail it.',
  files: (() => {
    const files = healthyDeployableFiles({
      name: 'acme-shop-api',
      serverJs: `const express = require('express');
const cors = require('cors');
const inventory = require('./config');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/inventory', async (req, res) => {
  const res2 = await fetch(inventory.baseUrl + '/v1/stock', {
    headers: { 'x-api-key': inventory.apiKey },
  });
  res.json(await res2.json());
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('acme shop api listening on port ' + PORT);
});
`,
    });
    files['config.js'] = `// Credentials for the inventory sync integration.
const apiKey = 'AKIA2Q3J4H7G9F1D3S5A7Z';
const secret = 'k7mN2pQ9rS4tV8wX1yZ3bC6dF0gH5jL8aS2dF4g7';

module.exports = {
  apiKey,
  secret,
  baseUrl: 'https://inventory.acme-corp.io',
};
`;
    return files;
  })(),
  expect: { secrets: ['fail', 'check-it'] },
};

/* --------------------------------------------------------------------------
 * POSITIVE CONTROLS — provably-correct mini-repos; every listed check must
 * stay inside its allowed status set. Allowed sets were pinned to the
 * ACTUAL correct answer of each specialist (read line-by-line), so a
 * specialist that starts drifting (e.g. newly bowing out, or newly
 * flagging) is caught.
 * ------------------------------------------------------------------------ */

// -- control-perfect-deployable: textbook Express deployable --
// engines + start + build + lockfile + Dockerfile(node:20) + bare process.env.PORT
// (NO `|| 8080` fallback — the specialist treats PORT fallbacks as check-it!)
// + 0.0.0.0 bind + /health + cors dep + express.static + env-based config + no DB.
const C_PERFECT_DEPLOYABLE = {
  slug: 'mach-speed-exam/control-perfect-deployable',
  kind: 'control',
  expectedType: 'deployable',
  note: 'Textbook Express deployable — engines, start, build, lockfile, Dockerfile, bare process.env.PORT, 0.0.0.0 bind, /health, restrictive CORS via env, express.static, env-based config, no secrets, no DB. All applicable checks must pass; database-config correctly bows out (no DB anywhere).',
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: SERVER_HEALTHY,
  }),
  expect: {
    'dynamic-port': ['pass'],
    'host-binding': ['pass'],
    'start-script': ['pass'],
    'node-version': ['pass'],
    'build-step': ['pass'],
    'static-files': ['pass'],
    'health-check': ['pass'],
    cors: ['pass'],
    'env-vars': ['pass'],
    'database-config': ['not-applicable'],
    lockfile: ['pass'],
    secrets: ['pass'],
  },
};

// -- control-perfect-tool: tiny correct CLI (bin + commander, no server) --
// Reads process.env.PKGTOOL_FORMAT (env-vars pass), has start+build+engines+lockfile.
// The six server-scoped checks are filtered out by shouldRun() on repoType 'tool',
// i.e. they never even run — evaluate() scores a missing row as not-applicable.
const C_PERFECT_TOOL = {
  slug: 'mach-speed-exam/control-perfect-tool',
  kind: 'control',
  expectedType: 'tool',
  note: 'Tiny correct CLI — bin entry, commander, start+build scripts, engines, lockfile, reads process.env for its format setting, no server anywhere. The six universal checks must pass; server-scoped checks legitimately never run (not-applicable).',
  files: {
    'package.json': pkg({
      name: 'pkgtool',
      version: '1.2.0',
      description: 'CLI that inspects package manifests and prints a one-line summary',
      bin: { pkgtool: 'bin/pkgtool.js' },
      scripts: {
        start: 'node bin/pkgtool.js',
        build: 'esbuild bin/pkgtool.js --bundle --platform=node --outfile=dist/pkgtool.js',
      },
      engines: { node: '>=20' },
      keywords: ['cli', 'npm', 'inspect'],
      license: 'MIT',
      dependencies: { commander: '^12.1.0' },
      devDependencies: { esbuild: '^0.21.5' },
    }),
    'bin/pkgtool.js': `#!/usr/bin/env node
const { program } = require('commander');
const { summarize } = require('../lib/summarize');

program
  .name('pkgtool')
  .description('Print a one-line summary of a package manifest')
  .argument('[manifest]', 'path to package.json', 'package.json')
  .option('--json', 'emit the summary as JSON')
  .action((manifestPath, options) => {
    const format = process.env.PKGTOOL_FORMAT || (options.json ? 'json' : 'text');
    const summary = summarize(manifestPath);
    if (format === 'json') {
      console.log(JSON.stringify(summary));
    } else {
      console.log(summary.name + '@' + summary.version + ' — ' + summary.dependencyCount + ' dependencies');
    }
  });

program.parse(process.argv);
`,
    'lib/summarize.js': `const fs = require('node:fs');

function summarize(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const deps = Object.keys(manifest.dependencies || {});
  return {
    name: manifest.name || 'unknown',
    version: manifest.version || '0.0.0',
    dependencyCount: deps.length,
  };
}

module.exports = { summarize };
`,
    'README.md': '# pkgtool\n\nCLI that inspects package manifests and prints a one-line summary.\n',
    'package-lock.json': npmLock('pkgtool', '1.2.0', { commander: '^12.1.0' }, { esbuild: '^0.21.5' }),
  },
  expect: {
    'start-script': ['pass'],
    'build-step': ['pass'],
    lockfile: ['pass'],
    'node-version': ['pass'],
    'env-vars': ['pass'],
    secrets: ['pass'],
    'dynamic-port': ['not-applicable'],
    'host-binding': ['not-applicable'],
    'health-check': ['not-applicable'],
    cors: ['not-applicable'],
    'static-files': ['not-applicable'],
    'database-config': ['not-applicable'],
  },
};

// -- control-perfect-library: tiny correct TypeScript library (main/exports, no server) --
const C_PERFECT_LIBRARY = {
  slug: 'mach-speed-exam/control-perfect-library',
  kind: 'control',
  expectedType: 'library',
  note: 'Tiny correct TypeScript library — main/types/exports, tsc build script, tsconfig, engines, lockfile, clean sources. Applicable checks must pass; server-scoped checks + start-script + env-vars correctly bow out.',
  files: {
    'package.json': pkg({
      name: 'tiny-tally',
      version: '3.0.1',
      description: 'Dependency-free counter and statistics helpers',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files: ['dist'],
      scripts: {
        build: 'tsc -p tsconfig.json',
        test: 'node --test',
      },
      engines: { node: '>=20' },
      keywords: ['library', 'utility', 'stats'],
      license: 'MIT',
      devDependencies: { typescript: '^5.5.4' },
    }),
    'tsconfig.json': pkg({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        declaration: true,
        skipLibCheck: true,
      },
      include: ['src'],
    }),
    'src/index.ts': `/** tiny-tally — dependency-free counter and statistics helpers. */

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    throw new Error('mean of empty list');
  }
  return sum(values) / values.length;
}

export function tally<T>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}
`,
    'README.md': '# tiny-tally\n\nDependency-free counter and statistics helpers.\n',
    'package-lock.json': npmLock('tiny-tally', '3.0.1', {}, { typescript: '^5.5.4' }),
  },
  expect: {
    'build-step': ['pass'],
    lockfile: ['pass'],
    'node-version': ['pass'],
    secrets: ['pass'],
    'start-script': ['not-applicable'],
    'env-vars': ['not-applicable'],
    'dynamic-port': ['not-applicable'],
    'host-binding': ['not-applicable'],
    'health-check': ['not-applicable'],
    cors: ['not-applicable'],
    'static-files': ['not-applicable'],
    'database-config': ['not-applicable'],
  },
};

/* --------------------------------------------------------------------------
 * The full fixture set: 12 mutants (one per specialist check) + 3 controls.
 * ------------------------------------------------------------------------ */

export const FIXTURES = [
  // Mutants, one per check
  M_DYNAMIC_PORT,
  M_HOST_BINDING,
  M_START_SCRIPT,
  M_NODE_VERSION,
  M_BUILD_STEP,
  M_STATIC_FILES,
  M_HEALTH_CHECK,
  M_CORS,
  M_ENV_VARS,
  M_DATABASE_CONFIG,
  M_LOCKFILE,
  M_SECRETS,
  // Positive controls
  C_PERFECT_DEPLOYABLE,
  C_PERFECT_TOOL,
  C_PERFECT_LIBRARY,
];
