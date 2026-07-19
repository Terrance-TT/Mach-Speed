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
 * Fixture content was crafted against the ACTUAL detection logic of the 17
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
    description: 'Acme shop API — storefront order service',
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
  <p>Static landing page for the acme storefront.</p>
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
  note: 'Express deployable whose package.json has only dev/build scripts — no start, serve or start:prod, and NO Dockerfile/Procfile entrypoint anywhere. start-script must fail it.',
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
      // A Dockerfile is present (keeps the deployable classification) but defines
      // NO CMD/ENTRYPOINT — so there is genuinely no start command anywhere.
      Dockerfile: `FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
`,
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

// -- build-step: TypeScript library (tsc devDep, no tsconfig) with NO build script --
const M_BUILD_STEP = {
  slug: 'mach-speed-exam/mutant-build-step-missing',
  kind: 'mutant',
  expectedType: 'library',
  note: 'TypeScript library shipping dist/ output (main: dist/index.js) with a typescript devDependency but NO tsconfig and NO scripts.build — nothing anywhere defines how dist/ gets built. build-step must fail it.',
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
  note: 'CLI tool whose deploy-API config (base URL, region, timeout) is hardcoded in lib/config.js with zero process.env/import.meta.env reads in any source file, and no scripts/configs that manage env anywhere — env-vars must flag it.',
  files: {
    'package.json': pkg({
      name: 'shiptool',
      version: '0.9.1',
      description: 'CLI for shipping release manifests to the internal deploy API',
      bin: { shiptool: 'bin/shiptool.js' },
      scripts: {},
      engines: { node: '>=20' },
      keywords: ['cli', 'deploy'],
      license: 'MIT',
      dependencies: { commander: '^12.1.0' },
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
    'package-lock.json': npmLock('shiptool', '0.9.1', { commander: '^12.1.0' }),
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
 * NEW SPECIALISTS — wave-1-style mutants for the five checks added after the
 * original dozen (ai-api-config, auth-config, object-storage, payment-config,
 * platform-lock-in). One unambiguous injected fault each: these prove the new
 * specialist FIRES at all on its core fault. Adversarial variants come later.
 * ------------------------------------------------------------------------ */

// -- ai-api-config: openai dep + a LIVE AI key hardcoded in a frontend component --
const M_AI_API_EXPOSED = {
  slug: 'mach-speed-exam/mutant-ai-api-config-exposed-key',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable with an openai dependency whose browser widget instantiates new OpenAI({ apiKey: 'sk-proj-...' }) in src/components/Chat.jsx — a live AI key hardcoded in frontend code. ai-api-config must flag it.",
  files: (() => {
    const deps = { ...STD_DEPS, openai: '^4.52.7' };
    const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
    files['src/components/Chat.jsx'] = `import { useState } from 'react';
import OpenAI from 'openai';

// Support-chat widget — calls the model directly from the browser.
const openai = new OpenAI({ apiKey: 'sk-proj-a1B2c3D4e5F6g7H8i9J0k1L2m3N4' });

export function Chat() {
  const [answer, setAnswer] = useState('');

  async function ask(question) {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: question }],
    });
    setAnswer(res.choices[0].message.content);
  }

  return (
    <section>
      <button onClick={() => ask('Where is my order?')}>Ask support</button>
      <p>{answer}</p>
    </section>
  );
}
`;
    return files;
  })(),
  expect: { 'ai-api-config': ['fail', 'check-it'] },
};

// -- auth-config: jsonwebtoken dep + jwt.sign() with a hardcoded secret literal --
const M_AUTH_HARDCODED = {
  slug: 'mach-speed-exam/mutant-auth-config-hardcoded-secret',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable with a jsonwebtoken dependency whose lib/auth.js signs sessions with a hardcoded secret literal instead of an env var. auth-config must flag it.",
  files: (() => {
    const deps = { ...STD_DEPS, jsonwebtoken: '^9.0.2' };
    const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
    files['lib/auth.js'] = `const jwt = require('jsonwebtoken');

function signSession(user) {
  // Session token, valid for 30 days.
  return jwt.sign({ userId: user.id }, 'a9f3k8d2s7h6g5f4d3s2a1z0x9c8v7b6');
}

function verifySession(token) {
  return jwt.verify(token, 'a9f3k8d2s7h6g5f4d3s2a1z0x9c8v7b6');
}

module.exports = { signSession, verifySession };
`;
    return files;
  })(),
  expect: { 'auth-config': ['fail', 'check-it'] },
};

// -- object-storage: multer dep + uploads written to the local filesystem --
const M_OBJECT_STORAGE_LOCAL = {
  slug: 'mach-speed-exam/mutant-object-storage-local-upload',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable whose photo-upload route stores files on local disk via multer diskStorage (path.join(__dirname, 'uploads')) — ephemeral on Render/Railway, lost on every restart. object-storage must flag it.",
  files: (() => {
    const deps = { ...STD_DEPS, multer: '^1.4.5-lts.1' };
    const serverJs = `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));
app.use(require('./routes/upload'));

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
    const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs });
    files['routes/upload.js'] = `const express = require('express');
const multer = require('multer');
const path = require('node:path');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

router.post('/api/upload', upload.single('photo'), (req, res) => {
  res.json({ saved: req.file.filename });
});

module.exports = router;
`;
    return files;
  })(),
  expect: { 'object-storage': ['fail', 'check-it'] },
};

// -- payment-config: stripe dep with a checkout route but NO webhook handler anywhere --
const M_PAYMENT_NO_WEBHOOK = {
  slug: 'mach-speed-exam/mutant-payment-config-no-webhook',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable with a stripe dependency and an env-based checkout route (api/billing.js) but no webhook endpoint anywhere — payment events are never handled. payment-config must flag it.",
  files: (() => {
    const deps = { ...STD_DEPS, stripe: '^16.2.0' };
    const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
    files['api/billing.js'] = `const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession(itemId) {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: process.env.APP_URL + '/success',
    cancel_url: process.env.APP_URL + '/cancel',
  });
  return session;
}

module.exports = { createCheckoutSession };
`;
    return files;
  })(),
  expect: { 'payment-config': ['fail', 'check-it'] },
};

// -- platform-lock-in: depends on a proprietary Replit-only package --
const M_PLATFORM_LOCKIN_REPLIT = {
  slug: 'mach-speed-exam/mutant-platform-lock-in-replit-dep',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Healthy Express deployable that depends on @replit/object-storage — a proprietary Replit-only package that must be replaced before migrating anywhere. platform-lock-in must fail it.",
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    deps: { ...STD_DEPS, '@replit/object-storage': '^1.0.1' },
    serverJs: SERVER_HEALTHY,
  }),
  expect: { 'platform-lock-in': ['fail', 'check-it'] },
};

/* --------------------------------------------------------------------------
 * WAVE 2 — ADVERSARIAL MUTANTS. Each is engineered to slip past a KNOWN blind
 * spot in current detection logic (presence-only checks, filename gates,
 * comment-insensitive regexes, entropy thresholds, presence-only lockfiles).
 * They measure detection QUALITY, not detection PRESENCE. Several are missed
 * by the current suite on purpose — the self-heal loop is expected to close
 * them; the gate requires any rewrite of that check to catch ALL its mutants.
 * ------------------------------------------------------------------------ */

// -- cors #2: cors IS configured — but wide open (origin '*' + credentials) --
const M_CORS_WIDE_OPEN = {
  slug: 'mach-speed-exam/mutant-cors-wide-open',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express API whose CORS is configured but dangerously wide open: origin '*' together with credentials: true. A presence-only check passes it — a correct specialist must flag the misconfiguration.",
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: `const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
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
`,
  }),
  expect: { cors: ['fail', 'check-it'] },
};

// -- secrets #2: credentials split into short low-entropy concatenated parts --
// (every quoted fragment is <=8 chars, so literal-length and entropy scans miss it)
const M_SECRETS_SPLIT = {
  slug: 'mach-speed-exam/mutant-secrets-split-key',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Healthy Express deployable plus config.js whose AWS-style credentials are split into short concatenated string fragments — each fragment evades length/entropy scanning, but the assembled key is still hardcoded. secrets must flag it.",
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
// Split into pieces "for safety" — still hardcoded credentials.
const apiKey = 'AKIA2Q3J' + '4H7G9F1D' + '3S5A7Z22';
const secret = 'k7mN2pQ9' + 'rS4tV8wX' + '1yZ3bC6d' + 'F0gH5jL8' + 'aS2dF4g7';

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

// -- database-config #2: hardcoded conn string in a file whose NAME says nothing --
// (lib/store.js matches no db/database filename gate, so it is never even scanned)
const M_DB_CONFIG_HIDDEN = {
  slug: 'mach-speed-exam/mutant-database-config-hidden',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable with a pg Pool whose connection string (with credentials) is hardcoded in lib/store.js — a file whose name matches no database filename gate, so it is never scanned. database-config must find it and FAIL it (a shrug is not detection).",
  files: (() => {
    const deps = { ...STD_DEPS, pg: '^8.12.0' };
    const files = healthyDeployableFiles({
      name: 'acme-shop-api',
      deps,
      serverJs: `const express = require('express');
const cors = require('cors');
const { listItems } = require('./lib/store');

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
    files['lib/store.js'] = `const { Pool } = require('pg');

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
  expect: { 'database-config': ['fail'] },
};

// -- health-check #2: the /health route exists — but commented out --
// (content regexes do not strip comments, so the dead route still "detects")
const M_HEALTH_CHECK_ZOMBIE = {
  slug: 'mach-speed-exam/mutant-health-check-commented',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable whose only /health route is commented out — regexes that do not strip comments still 'find' it. A correct specialist must notice there is no LIVE health endpoint and flag it.",
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

// TODO: re-enable once the load balancer is configured
// app.get('/health', (req, res) => {
//   res.json({ ok: true });
// });

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

// -- host-binding #2: binds to a hardcoded PRIVATE interface IP (not localhost) --
// (only '127.0.0.1'/'localhost' literals are treated as bad — any other literal
//  host falls through to 'listens without explicit host' => pass)
const M_HOST_BINDING_PRIVATE_IP = {
  slug: 'mach-speed-exam/mutant-host-binding-private-ip',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable binding to a hardcoded private interface IP (10.0.0.5) — not localhost, but not all-interfaces either; unreachable once the container IP changes. host-binding must flag it.",
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
app.listen(PORT, '10.0.0.5', () => {
  console.log('acme shop api listening on 10.0.0.5:' + PORT);
});
`,
  }),
  expect: { 'host-binding': ['fail', 'check-it'] },
};

// -- static-files #2: express.static mounts the WRONG directory --
// (presence of express + an express.static call passes, even though 'assets'
//  does not exist and the real assets in public/ are never served)
const M_STATIC_FILES_WRONG_DIR = {
  slug: 'mach-speed-exam/mutant-static-files-wrong-dir',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable that calls express.static('assets') — but the assets directory does not exist; the real static files live in public/ and are never served. static-files must flag the broken serving.",
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
app.use('/static', express.static('assets'));

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

// -- lockfile #2: lockfile exists but is STALE (package.json declares pg,
//    the lockfile does not — npm ci would fail outright) --
const M_LOCKFILE_STALE = {
  slug: 'mach-speed-exam/mutant-lockfile-stale',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable whose package.json declares pg, but the package-lock.json predates it (pg is missing) — npm ci fails on mismatched lockfiles. A presence-only check passes it; lockfile must flag the stale lockfile.",
  files: (() => {
    const depsWithPg = { ...STD_DEPS, pg: '^8.12.0' };
    const files = {
      'package.json': appPkg({ name: 'acme-shop-api', scripts: STD_SCRIPTS, deps: depsWithPg }),
      'server.js': SERVER_HEALTHY,
      'public/index.html': PUBLIC_INDEX_HTML,
      Dockerfile: DOCKERFILE_NODE,
      // NOTE: lockfile deliberately built WITHOUT pg — it is stale vs package.json.
      'package-lock.json': npmLock('acme-shop-api', '1.4.2', STD_DEPS, { esbuild: '^0.21.5' }),
    };
    return files;
  })(),
  expect: { lockfile: ['fail', 'check-it'] },
};

/* --------------------------------------------------------------------------
 * WAVE 2B — ADVERSARIAL MUTANTS FOR THE NEWER SPECIALISTS. Each slips past a
 * KNOWN blind spot in one of the five checks added after the original dozen:
 * directory gates on file scans, comment-insensitive keyword detection,
 * presence-only documentation checks, package-name-only lock-in detection.
 * The current suite is expected to MISS all five — the loop closes them.
 * ------------------------------------------------------------------------ */

// -- ai-api-config #2: exposure in a browser-served dir the frontend scan never
//    reads (public/), plus a COMMENTED proxy example that fakes "backend proxy" --
const M_AI_API_PUBLIC = {
  slug: 'mach-speed-exam/mutant-ai-api-config-public-exposure',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable whose browser-served public/widget.js instantiates new OpenAI({ apiKey: 'sk-proj-...' }) — but public/ is outside every scanned dir, and a commented-out example in lib/openai.js trips the backend-proxy regexes. ai-api-config must not wave this through.",
  files: (() => {
    const deps = { ...STD_DEPS, openai: '^4.52.7' };
    const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
    files['public/widget.js'] = `// Support widget — served to browsers at /widget.js (OpenAI loaded via CDN).
const openai = new OpenAI({ apiKey: 'sk-proj-z9Y8x7W6v5U4t3S2r1Q0p9O8i7U6y5T4' });

async function askSupport(question) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: question }],
  });
  return res.choices[0].message.content;
}

window.acmeSupport = { askSupport };
`;
    files['lib/openai.js'] = `// Server-side AI proxy — EXAMPLE ONLY, kept for reference. Not wired anywhere.
// const OpenAI = require('openai');
// const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// async function complete(prompt) {
//   const res = await client.chat.completions.create({
//     model: 'gpt-4o-mini',
//     messages: [{ role: 'user', content: prompt }],
//   });
//   return res.choices[0].message.content;
// }
// module.exports = { complete };

module.exports = null;
`;
    return files;
  })(),
  expect: { 'ai-api-config': ['fail', 'check-it'] },
};

// -- auth-config #2: hardcoded JWT secret in a dir the source scan never reads
//    (config/), with .env.example documentation making it look configured --
const M_AUTH_HIDDEN = {
  slug: 'mach-speed-exam/mutant-auth-config-hidden-secret',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable whose config/auth.js signs sessions with a hardcoded jwt.sign() literal — config/ is outside every scanned dir, and .env.example dutifully documents JWT_SECRET, so the check reads 'configured'. auth-config must not wave this through.",
  files: (() => {
    const deps = { ...STD_DEPS, jsonwebtoken: '^9.0.2' };
    const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
    files['config/auth.js'] = `const jwt = require('jsonwebtoken');

function signSession(user) {
  // Session token, valid for 30 days.
  return jwt.sign({ userId: user.id }, 'f4d9s2a7k6h5g3d1s8a7z6x5c4v3b2n1');
}

function verifySession(token) {
  return jwt.verify(token, 'f4d9s2a7k6h5g3d1s8a7z6x5c4v3b2n1');
}

module.exports = { signSession, verifySession };
`;
    files['.env.example'] = `# Copy to .env and fill in real values
JWT_SECRET=
`;
    return files;
  })(),
  expect: { 'auth-config': ['fail', 'check-it'] },
};

// -- object-storage #2: uploads written to 'media/' (not one of the gated dir
//    names) using plain fs — no storage package anywhere to trigger on --
const M_OBJECT_STORAGE_MEDIA = {
  slug: 'mach-speed-exam/mutant-object-storage-media-dir',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable whose media route writes uploads to local disk via fs.writeFile('media/' + ...) — 'media/' matches none of the gated upload-dir names, and with no storage package installed the check concludes 'no storage detected'. object-storage must not shrug this off.",
  files: (() => {
    const serverJs = `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));
app.use(require('./routes/media'));

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
    const files = healthyDeployableFiles({ name: 'acme-shop-api', serverJs });
    files['routes/media.js'] = `const express = require('express');
const fs = require('node:fs');

const router = express.Router();

router.post('/api/media', express.raw({ type: 'image/*', limit: '5mb' }), (req, res) => {
  const fileName = Date.now() + '.bin';
  fs.writeFile('media/' + fileName, req.body, (err) => {
    if (err) return res.status(500).json({ error: 'save failed' });
    res.json({ saved: fileName });
  });
});

module.exports = router;
`;
    return files;
  })(),
  expect: { 'object-storage': ['fail', 'check-it'] },
};

// -- payment-config #2: the webhook handler exists — but entirely commented out,
//    and keyword detection (no comment stripping) counts it as live --
const M_PAYMENT_ZOMBIE_WEBHOOK = {
  slug: 'mach-speed-exam/mutant-payment-config-commented-webhook',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Express deployable with a stripe dependency whose only webhook handler is commented out in api/webhooks.js — keyword detection counts the dead code as a live webhook, and .env.example completes the illusion. payment-config must notice there is no LIVE webhook.",
  files: (() => {
    const deps = { ...STD_DEPS, stripe: '^16.2.0' };
    const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
    files['api/webhooks.js'] = `// Stripe webhook handler — DISABLED until the endpoint is registered in the dashboard.
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
//
// router.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
//   const event = stripe.webhooks.constructEvent(
//     req.body,
//     req.headers['stripe-signature'],
//     process.env.STRIPE_WEBHOOK_SECRET,
//   );
//   if (event.type === 'checkout.session.completed') {
//     // fulfill the order
//   }
//   res.json({ received: true });
// });

module.exports = {};
`;
    files['.env.example'] = `# Copy to .env and fill in real values
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
`;
    return files;
  })(),
  expect: { 'payment-config': ['fail', 'check-it'] },
};

// -- platform-lock-in #2: coupled to Replit-only ENVIRONMENT (REPLIT_DB_URL,
//    REPL_ID) with zero Replit packages — package-name detection sees nothing --
const M_PLATFORM_LOCKIN_ENV = {
  slug: 'mach-speed-exam/mutant-platform-lock-in-env-vars',
  kind: 'mutant',
  expectedType: 'deployable',
  note: "Healthy Express deployable that reads Replit-only environment variables (REPLIT_DB_URL, REPL_ID) — no Replit packages and no .replit config, so package-name detection reports 'no lock-in', yet the app only runs on Replit. platform-lock-in must flag the environment coupling.",
  files: healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: `const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());
app.use(express.static('public'));

// Replit-provided environment — the app relies on Replit's database + repl identity.
const dbUrl = process.env.REPLIT_DB_URL;
const replId = process.env.REPL_ID;

const items = [{ id: 1, name: 'widget' }];

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/items', (req, res) => {
  res.json({ items, repl: replId });
});

const PORT = process.env.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log('acme shop api listening on port ' + PORT + ' db=' + dbUrl);
});
`,
  }),
  expect: { 'platform-lock-in': ['fail', 'check-it'] },
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
    'ai-api-config': ['not-applicable'],
    'auth-config': ['not-applicable'],
    'object-storage': ['not-applicable'],
    'payment-config': ['not-applicable'],
    'platform-lock-in': ['pass'],
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
    'ai-api-config': ['not-applicable'],
    'auth-config': ['not-applicable'],
    'object-storage': ['not-applicable'],
    'payment-config': ['not-applicable'],
    'platform-lock-in': ['pass'],
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
    'ai-api-config': ['not-applicable'],
    'auth-config': ['not-applicable'],
    'object-storage': ['not-applicable'],
    'payment-config': ['not-applicable'],
    'platform-lock-in': ['pass'],
  },
};

/* --------------------------------------------------------------------------
 * The full fixture set: 12 wave-1 mutants (one per original check) + 5 wave-1
 * mutants for the newer specialists + 12 wave-2 adversarial mutants (7 for the
 * original checks + 5 for the newer ones) + 3 controls = 32 fixtures.
 * ------------------------------------------------------------------------ */

export const FIXTURES = [
  // Mutants, one per check (wave 1)
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
  // New specialists (ai-api-config, auth-config, object-storage, payment-config, platform-lock-in)
  M_AI_API_EXPOSED,
  M_AUTH_HARDCODED,
  M_OBJECT_STORAGE_LOCAL,
  M_PAYMENT_NO_WEBHOOK,
  M_PLATFORM_LOCKIN_REPLIT,
  // Adversarial mutants (wave 2 — aimed at known blind spots)
  M_CORS_WIDE_OPEN,
  M_SECRETS_SPLIT,
  M_DB_CONFIG_HIDDEN,
  M_HEALTH_CHECK_ZOMBIE,
  M_HOST_BINDING_PRIVATE_IP,
  M_STATIC_FILES_WRONG_DIR,
  M_LOCKFILE_STALE,
  // Adversarial mutants for the newer specialists (wave 2b)
  M_AI_API_PUBLIC,
  M_AUTH_HIDDEN,
  M_OBJECT_STORAGE_MEDIA,
  M_PAYMENT_ZOMBIE_WEBHOOK,
  M_PLATFORM_LOCKIN_ENV,
  // Positive controls
  C_PERFECT_DEPLOYABLE,
  C_PERFECT_TOOL,
  C_PERFECT_LIBRARY,
];
