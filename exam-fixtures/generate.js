/**
 * exam-fixtures/generate.js — the seeded, rotating fixture generator.
 *
 * Why this exists: a static exam can be memorized. generateFixtures(seed)
 * produces the same FAULT CLASSES with fresh SURFACE DETAILS every exam
 * version (dir names, file names, variable names, key material, obfuscation
 * style, comment style). Detection must generalize — pattern-matching our
 * handwriting cannot win twice.
 *
 * Design rules:
 *   - Deterministic: same seed -> byte-identical fixture set (the verify gate
 *     compares baseline vs candidate on the SAME generated set within a run).
 *   - Surface-only variation: randomization never changes what the correct
 *     answer is — every generated repo is an unambiguous instance of its
 *     fault class. (The de-ambiguation rule learned from wave 1.)
 *   - Rotation: the template pool (14) is larger than the per-version sample
 *     (8), so passing one version does not prove passing the pool.
 *   - Pure module: no I/O on import. Seed resolution with I/O lives in
 *     resolveExamSeed(), explicitly called by the pipeline.
 *
 * Seed persistence: exam-seed.json on the auto-fix-state branch. The pipeline
 * bumps it only after a FULLY GREEN exam (all mutants caught, all controls
 * green) — "perfect score -> bump the seed". Unavailable -> seed 1.
 */

import {
  pkg, npmLock, healthyDeployableFiles, SERVER_HEALTHY, STD_SCRIPTS, STD_DEPS, DOCKERFILE_NODE,
} from './specs.js';

// Duplicated on purpose (auto-fix.js owns the canonical constant) — importing
// auto-fix.js here would create an import cycle via auto-heal.js.
const STATE_BRANCH = 'auto-fix-state';
export const EXAM_SEED_PATH = 'exam-seed.json';
export const DEFAULT_SAMPLE = 8;

/* --------------------------------------------------------------------------
 * Deterministic PRNG (mulberry32) + helpers
 * ------------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randString(rng, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALNUM[Math.floor(rng() * ALNUM.length)];
  return s;
}

/* --------------------------------------------------------------------------
 * Variation tables — SURFACE DETAILS ONLY. Changing one of these must never
 * change what the correct answer is.
 * ------------------------------------------------------------------------ */

const CONFIG_DIRS = ['config', 'lib/config', 'src/config', 'server/config', 'app/config'];
const CONFIG_FILES = ['config.js', 'keys.js', 'settings.js', 'env.js'];
const STORE_FILES = ['store.js', 'db-client.js', 'data.js', 'connection.js', 'repo.js'];
const EVASIVE_UPLOAD_DIRS = ['media', 'assets', 'data', 'content', 'blob'];
const SERVED_DIRS = ['public', 'static', 'assets'];
const HEALTH_PATHS = ['/health', '/healthz', '/ready'];
const PRIVATE_IPS = ['10.0.0.5', '10.1.2.3', '172.16.0.10', '192.168.1.50'];
const WRONG_STATIC_DIRS = ['assets', 'web', 'static-assets', 'client-dist'];
const STALE_DEPS = [
  { name: 'pg', range: '^8.12.0' },
  { name: 'redis', range: '^4.6.14' },
  { name: 'stripe', range: '^16.2.0' },
  { name: 'jsonwebtoken', range: '^9.0.2' },
];
const WEBHOOK_FILES = ['api/webhooks.js', 'api/stripe-hooks.js', 'api/payments.js'];
const PORTS = [3000, 4000, 5000, 8080, 9000];
const REPLIT_ENV_VARS = ['REPLIT_DB_URL', 'REPL_ID', 'REPL_SLUG', 'REPLIT_DOMAINS'];

/** A valid sk-proj-shaped key with fresh material each seed. */
const fakeAiKey = (rng) => `sk-proj-${randString(rng, 24)}`;
/** A 32-char high-entropy-looking secret. */
const fakeSecret = (rng) => randString(rng, 32);

/* --------------------------------------------------------------------------
 * Fault-class templates. Each make(rng, seed) returns a complete fixture spec
 * (same shape as specs.js FIXTURES entries). Slugs carry the seed so exam
 * versions never collide in the snapshot cache.
 * ------------------------------------------------------------------------ */

function corsWideOpen(rng, seed) {
  const variant = pick(rng, [
    `app.use(cors({ origin: '*', credentials: true }));`,
    `app.use(cors({ origin: true, credentials: true })); // reflect any origin`,
  ]);
  return {
    slug: `mach-speed-exam/g${seed}-cors-wide-open`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the cors-wide-open fault class: CORS is configured but wide open (any origin, with credentials). A presence-only check passes it.`,
    files: healthyDeployableFiles({
      name: 'acme-shop-api',
      serverJs: SERVER_HEALTHY.replace(
        "app.use(cors({ origin: allowedOrigin }));",
        variant,
      ),
    }),
    expect: { cors: ['fail', 'check-it'] },
  };
}

function secretsSplit(rng, seed) {
  const dir = pick(rng, CONFIG_DIRS);
  const file = pick(rng, CONFIG_FILES);
  const parts = 2 + Math.floor(rng() * 3); // 2-4 fragments
  const fragments = Array.from({ length: parts }, () => `'${randString(rng, 6 + Math.floor(rng() * 3))}'`);
  const varName = pick(rng, ['apiKey', 'serviceKey', 'token', 'accessKey']);
  const files = healthyDeployableFiles({
    name: 'acme-shop-api',
    serverJs: SERVER_HEALTHY,
  });
  files[`${dir}/${file}`] = `// Integration credentials — split into pieces "for safety".
// Still hardcoded: the assembled key never leaves the repo.
const ${varName} = ${fragments.join(' + ')};

module.exports = { ${varName} };
`;
  return {
    slug: `mach-speed-exam/g${seed}-secrets-split-key`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the secrets-split fault class: credentials assembled from short concatenated fragments in ${dir}/${file} — each fragment evades length/entropy scanning.`,
    files,
    expect: { secrets: ['fail', 'check-it'] },
  };
}

function dbConfigHidden(rng, seed) {
  const dir = pick(rng, CONFIG_DIRS);
  const file = pick(rng, STORE_FILES);
  const dbName = pick(rng, ['shopdb', 'orders', 'acme_prod']);
  const deps = { ...STD_DEPS, pg: '^8.12.0' };
  const files = healthyDeployableFiles({
    name: 'acme-shop-api',
    deps,
    serverJs: SERVER_HEALTHY.replace(
      "const items = [{ id: 1, name: 'widget' }];",
      `const { listItems } = require('./${dir}/${file.replace(/\.js$/, '')}');`,
    ).replace(
      'res.json({ items });',
      'res.json({ items: await listItems() });',
    ).replace(
      "app.get('/api/items', (req, res) => {",
      "app.get('/api/items', async (req, res) => {",
    ),
  });
  files[`${dir}/${file}`] = `const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:postgres@db.internal.acme:5432/${dbName}',
});

async function listItems() {
  const { rows } = await pool.query('SELECT id, name FROM items ORDER BY id');
  return rows;
}

module.exports = { pool, listItems };
`;
  return {
    slug: `mach-speed-exam/g${seed}-db-config-hidden`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the db-config-hidden fault class: hardcoded pg connection string (with credentials) in ${dir}/${file} — a file whose name matches no database filename gate. Strict: a shrug is not detection.`,
    files,
    expect: { 'database-config': ['fail'] },
  };
}

function healthCheckCommented(rng, seed) {
  const route = pick(rng, HEALTH_PATHS);
  const style = pick(rng, ['line', 'block']);
  const dead = style === 'line'
    ? `// TODO: re-enable once the load balancer is configured\n// app.get('${route}', (req, res) => {\n//   res.json({ ok: true });\n// });`
    : `/* Disabled until the load balancer is configured.\napp.get('${route}', (req, res) => {\n  res.json({ ok: true });\n}); */`;
  return {
    slug: `mach-speed-exam/g${seed}-health-check-commented`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the health-check-zombie fault class: the only health route (${route}) is commented out (${style} comment) — regexes that do not strip comments still 'find' it.`,
    files: healthyDeployableFiles({
      name: 'acme-shop-api',
      serverJs: SERVER_HEALTHY.replace(
        `app.get('/health', (req, res) => {\n  res.json({ ok: true });\n});`,
        dead,
      ),
    }),
    expect: { 'health-check': ['fail', 'check-it'] },
  };
}

function hostBindingPrivateIp(rng, seed) {
  const ip = pick(rng, PRIVATE_IPS);
  return {
    slug: `mach-speed-exam/g${seed}-host-binding-private-ip`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the host-binding fault class: binds to a hardcoded private interface IP (${ip}) — not localhost, but not all-interfaces either.`,
    files: healthyDeployableFiles({
      name: 'acme-shop-api',
      serverJs: SERVER_HEALTHY.replace("'0.0.0.0'", `'${ip}'`).replace(
        "'acme shop api listening on port ' + PORT",
        `'acme shop api listening on ${ip}:' + PORT`,
      ),
    }),
    expect: { 'host-binding': ['fail', 'check-it'] },
  };
}

function staticFilesWrongDir(rng, seed) {
  const wrongDir = pick(rng, WRONG_STATIC_DIRS);
  const mount = pick(rng, ['/static', '/assets', '/files']);
  return {
    slug: `mach-speed-exam/g${seed}-static-files-wrong-dir`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the static-files fault class: express.static('${wrongDir}') mounts a directory that does not exist — the real assets live in public/ and are never served.`,
    files: healthyDeployableFiles({
      name: 'acme-shop-api',
      serverJs: SERVER_HEALTHY.replace(
        "app.use(express.static('public'));",
        `app.use('${mount}', express.static('${wrongDir}'));`,
      ),
    }),
    expect: { 'static-files': ['fail', 'check-it'] },
  };
}

function lockfileStale(rng, seed) {
  const missing = pick(rng, STALE_DEPS);
  const depsWithMissing = { ...STD_DEPS, [missing.name]: missing.range };
  const files = {
    'package.json': pkg({
      name: 'acme-shop-api',
      version: '1.4.2',
      private: true,
      description: 'Acme shop API — storefront order service',
      scripts: STD_SCRIPTS,
      dependencies: depsWithMissing,
      devDependencies: { esbuild: '^0.21.5' },
      engines: { node: '>=20' },
    }),
    'server.js': SERVER_HEALTHY,
    'public/index.html': '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>acme shop</title>\n</head>\n<body>\n  <h1>acme shop</h1>\n</body>\n</html>\n',
    Dockerfile: DOCKERFILE_NODE,
    // Lockfile deliberately built WITHOUT the missing dep — it is stale vs package.json.
    'package-lock.json': npmLock('acme-shop-api', '1.4.2', STD_DEPS, { esbuild: '^0.21.5' }),
  };
  return {
    slug: `mach-speed-exam/g${seed}-lockfile-stale`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the lockfile-stale fault class: package.json declares ${missing.name}, the package-lock predates it — npm ci fails on mismatched lockfiles.`,
    files,
    expect: { lockfile: ['fail', 'check-it'] },
  };
}

function aiApiPublicExposure(rng, seed) {
  const servedDir = pick(rng, SERVED_DIRS);
  const widget = pick(rng, ['widget.js', 'support.js', 'chat.js']);
  const deps = { ...STD_DEPS, openai: '^4.52.7' };
  const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
  files[`${servedDir}/${widget}`] = `// Support widget — served to browsers at /${widget} (OpenAI loaded via CDN).
const openai = new OpenAI({ apiKey: '${fakeAiKey(rng)}' });

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
// module.exports = { complete: async (prompt) => prompt };

module.exports = null;
`;
  return {
    slug: `mach-speed-exam/g${seed}-ai-api-public-exposure`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the ai-api-exposure fault class: live AI key hardcoded in browser-served ${servedDir}/${widget} (outside every scanned dir), plus a commented proxy example that trips backend-proxy regexes.`,
    files,
    expect: { 'ai-api-config': ['fail', 'check-it'] },
  };
}

function authHiddenSecret(rng, seed) {
  const dir = pick(rng, CONFIG_DIRS);
  const secret = fakeSecret(rng);
  const deps = { ...STD_DEPS, jsonwebtoken: '^9.0.2' };
  const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
  files[`${dir}/auth.js`] = `const jwt = require('jsonwebtoken');

function signSession(user) {
  // Session token, valid for 30 days.
  return jwt.sign({ userId: user.id }, '${secret}');
}

function verifySession(token) {
  return jwt.verify(token, '${secret}');
}

module.exports = { signSession, verifySession };
`;
  files['.env.example'] = `# Copy to .env and fill in real values
JWT_SECRET=
`;
  return {
    slug: `mach-speed-exam/g${seed}-auth-config-hidden-secret`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the auth-config-hidden fault class: jwt.sign() with a hardcoded literal in ${dir}/auth.js (outside every scanned dir), while .env.example dutifully documents JWT_SECRET.`,
    files,
    expect: { 'auth-config': ['fail', 'check-it'] },
  };
}

function objectStorageMediaDir(rng, seed) {
  const dir = pick(rng, EVASIVE_UPLOAD_DIRS);
  const style = pick(rng, ['callback', 'promises']);
  const writer = style === 'callback'
    ? `const fs = require('node:fs');\n\nfunction save(name, body, cb) {\n  fs.writeFile('${dir}/' + name, body, cb);\n}`
    : `const fsp = require('node:fs').promises;\n\nasync function save(name, body) {\n  await fsp.writeFile('${dir}/' + name, body);\n}`;
  const serverJs = SERVER_HEALTHY.replace(
    "const items = [{ id: 1, name: 'widget' }];",
    `app.post('/api/media', express.raw({ type: 'image/*', limit: '5mb' }), (req, res) => {\n  const fileName = Date.now() + '.bin';\n  saveMedia(fileName, req.body, () => res.json({ saved: fileName }));\n});\n\nconst items = [{ id: 1, name: 'widget' }];`,
  ).replace(
    "const app = express();",
    "const app = express();\nconst { saveMedia } = require('./lib/media');",
  );
  const files = healthyDeployableFiles({ name: 'acme-shop-api', serverJs });
  files['lib/media.js'] = `${writer}\n\nmodule.exports = { saveMedia: save };\n`;
  return {
    slug: `mach-speed-exam/g${seed}-object-storage-media-dir`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the object-storage fault class: uploads written to local disk in '${dir}/' (${style} style) — matches none of the gated upload-dir names, and no storage package is installed.`,
    files,
    expect: { 'object-storage': ['fail', 'check-it'] },
  };
}

function paymentCommentedWebhook(rng, seed) {
  const file = pick(rng, WEBHOOK_FILES);
  const style = pick(rng, ['line', 'block']);
  const inner = `router.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const event = stripe.webhooks.constructEvent(
    req.body,
    req.headers['stripe-signature'],
    process.env.STRIPE_WEBHOOK_SECRET,
  );
  if (event.type === 'checkout.session.completed') {
    // fulfill the order
  }
  res.json({ received: true });
});`;
  const body = style === 'line'
    ? `// Stripe webhook handler — DISABLED until the endpoint is registered.\n// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);\n//\n${inner.split('\n').map((l) => `// ${l}`).join('\n')}`
    : `/* Stripe webhook handler — DISABLED until the endpoint is registered.\nconst stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);\n\n${inner}\n*/`;
  const deps = { ...STD_DEPS, stripe: '^16.2.0' };
  const files = healthyDeployableFiles({ name: 'acme-shop-api', deps, serverJs: SERVER_HEALTHY });
  files[file] = `${body}\n\nmodule.exports = {};\n`;
  files['.env.example'] = `# Copy to .env and fill in real values
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
`;
  return {
    slug: `mach-speed-exam/g${seed}-payment-commented-webhook`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the payment-webhook fault class: the only webhook handler is commented out (${style} comment) in ${file} — keyword detection counts dead code as a live webhook.`,
    files,
    expect: { 'payment-config': ['fail', 'check-it'] },
  };
}

function platformLockInEnv(rng, seed) {
  const count = 2 + Math.floor(rng() * 2);
  const vars = shuffle(rng, [...REPLIT_ENV_VARS]).slice(0, count);
  const reads = vars.map((v) => `const ${v.toLowerCase().replace(/_/g, '')} = process.env.${v};`).join('\n');
  return {
    slug: `mach-speed-exam/g${seed}-platform-lock-in-env`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the platform-lock-in fault class: reads Replit-only environment (${vars.join(', ')}) with zero Replit packages — package-name detection reports 'no lock-in'.`,
    files: healthyDeployableFiles({
      name: 'acme-shop-api',
      serverJs: SERVER_HEALTHY.replace(
        'const app = express();',
        `// Replit-provided environment — the app only runs on Replit.\n${reads}\n\nconst app = express();`,
      ),
    }),
    expect: { 'platform-lock-in': ['fail', 'check-it'] },
  };
}

function dynamicPortHardcoded(rng, seed) {
  const port = pick(rng, PORTS);
  return {
    slug: `mach-speed-exam/g${seed}-dynamic-port-hardcoded`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the dynamic-port fault class: app.listen(${port}) hardcoded, no process.env.PORT anywhere.`,
    files: healthyDeployableFiles({
      name: 'acme-shop-api',
      serverJs: SERVER_HEALTHY.replace(
        'const PORT = process.env.PORT;',
        `// Port pinned during development — works on the current host.\nconst PORT = ${port};`,
      ),
    }),
    expect: { 'dynamic-port': ['fail', 'check-it'] },
  };
}

function corsUnconfigured(rng, seed) {
  const excuse = pick(rng, [
    '// CORS is handled at the proxy in front of this service.',
    '// The gateway takes care of cross-origin headers.',
  ]);
  const deps = { express: '^4.19.2' };
  const files = healthyDeployableFiles({
    name: 'acme-shop-api',
    deps,
    serverJs: SERVER_HEALTHY.replace("const cors = require('cors');\n\n", '')
      .replace(
        "const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://app.acme-corp.io';\napp.use(cors({ origin: allowedOrigin }));",
        excuse,
      ),
  });
  return {
    slug: `mach-speed-exam/g${seed}-cors-unconfigured`,
    kind: 'mutant',
    expectedType: 'deployable',
    note: `Generated from the cors-unconfigured fault class: no CORS handling anywhere — no dependency, no middleware, no headers (only a comment claiming the proxy handles it).`,
    files,
    expect: { cors: ['fail', 'check-it'] },
  };
}

/* --------------------------------------------------------------------------
 * The template pool (14) — larger than the per-version sample (8) so the exam
 * ROTATES: passing one version does not prove passing the pool.
 * ------------------------------------------------------------------------ */

const TEMPLATES = [
  ['cors-wide-open', corsWideOpen],
  ['secrets-split-key', secretsSplit],
  ['db-config-hidden', dbConfigHidden],
  ['health-check-commented', healthCheckCommented],
  ['host-binding-private-ip', hostBindingPrivateIp],
  ['static-files-wrong-dir', staticFilesWrongDir],
  ['lockfile-stale', lockfileStale],
  ['ai-api-public-exposure', aiApiPublicExposure],
  ['auth-config-hidden-secret', authHiddenSecret],
  ['object-storage-media-dir', objectStorageMediaDir],
  ['payment-commented-webhook', paymentCommentedWebhook],
  ['platform-lock-in-env', platformLockInEnv],
  ['dynamic-port-hardcoded', dynamicPortHardcoded],
  ['cors-unconfigured', corsUnconfigured],
];

export const TEMPLATE_KEYS = TEMPLATES.map(([key]) => key);

/**
 * generateFixtures(seed, { sample }) -> deterministic fixture spec array.
 * Same seed -> identical output (byte-for-byte). Different seeds -> different
 * sample of fault classes with different surface details.
 */
export function generateFixtures(seed, { sample = DEFAULT_SAMPLE } = {}) {
  const s = (Number.isInteger(seed) && seed > 0 ? seed : 1) >>> 0;
  const rng = mulberry32(s);
  const order = shuffle(rng, [...TEMPLATES]);
  const picked = order.slice(0, Math.max(1, Math.min(sample, order.length)));
  return picked.map(([, make]) => make(rng, s));
}

/** Slugs the generator produces for a seed (for anti-gaming lint unions). */
export function generatedSlugs(seed, { sample = DEFAULT_SAMPLE } = {}) {
  return generateFixtures(seed, { sample }).map((f) => f.slug);
}

/**
 * resolveExamSeed() — the exam version for THIS run.
 * Priority: EXAM_SEED env override (testing) -> exam-seed.json on the
 * auto-fix-state branch -> 1. Never throws; seed 1 is the safe fallback.
 */
export async function resolveExamSeed({ slug = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN } = {}) {
  const forced = Number(process.env.EXAM_SEED);
  if (Number.isInteger(forced) && forced > 0) return forced;
  if (!slug) return 1;
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/contents/${EXAM_SEED_PATH}?ref=${STATE_BRANCH}`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) return 1;
    const data = await res.json();
    const seed = Number(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')).seed);
    return Number.isInteger(seed) && seed > 0 ? seed : 1;
  } catch {
    return 1;
  }
}
