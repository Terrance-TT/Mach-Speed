export const checkId = 'auth-config';
export const name = 'authentication configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

const isFile = (p) => !p.endsWith('/');

const AUTH_PACKAGES = [
  { pkg: 'next-auth', name: 'NextAuth' },
  { pkg: 'firebase', name: 'Firebase Auth' },
  { pkg: '@auth0/nextjs-auth0', name: 'Auth0' },
  { pkg: 'passport', name: 'Passport.js' },
  { pkg: 'jsonwebtoken', name: 'Custom JWT' },
  { pkg: 'jose', name: 'Custom JWT' },
  { pkg: 'jwt-decode', name: 'Custom JWT' },
  { pkg: 'express-session', name: 'Express Session' },
  { pkg: 'cookie-parser', name: 'Cookie Parser' },
];

const AUTH_PREFIXES = [
  { prefix: '@clerk/', name: 'Clerk' },
  { prefix: '@auth/', name: 'Auth.js' },
  { prefix: '@supabase/', name: 'Supabase Auth' },
];

const ENV_VARS_BY_PROVIDER = {
  'Clerk': ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'],
  'NextAuth': ['NEXTAUTH_URL', 'NEXTAUTH_SECRET'],
  'Firebase Auth': ['NEXT_PUBLIC_FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID'],
  'Auth0': ['AUTH0_SECRET', 'AUTH0_BASE_URL', 'AUTH0_ISSUER_BASE_URL', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'],
  'Supabase Auth': ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  'Passport.js': ['SESSION_SECRET'],
  'Custom JWT': ['JWT_SECRET'],
  'Express Session': ['SESSION_SECRET'],
  'Cookie Parser': ['COOKIE_SECRET'],
};

const DASHBOARD_HINTS = {
  'Clerk': 'Add new domain to https://dashboard.clerk.com',
  'Firebase Auth': 'Add new domain to Firebase Console > Authentication > Authorized domains',
  'Auth0': 'Add new domain to Auth0 dashboard > Allowed Callback URLs',
  'Supabase Auth': 'Add new domain to Supabase dashboard > Auth > Redirect URLs',
  'NextAuth': 'Update NEXTAUTH_URL for the new domain',
  'Auth.js': 'Update AUTH_URL for the new domain',
};

const DANGEROUS_PATTERNS = [
  /CLERK_SECRET_KEY\s*[:=]\s*["']sk_/,
  /CLERK_SECRET_KEY\s*[:=]\s*["'][^"']+/,
  /AUTH0_SECRET\s*[:=]\s*["'][^"']+/,
  /SESSION_SECRET\s*[:=]\s*["'][^"']{8,}/,
  /COOKIE_SECRET\s*[:=]\s*["'][^"']{8,}/,
  /jwt\.sign\s*\(.*,\s*["'][^"']+["']/,
  /jwt\.verify\s*\(.*,\s*["'][^"']+["']/,
  /\.setSecret\s*\(\s*["'][^"']+["']/,
  /createHmac\s*\(\s*["'][^"']+["']\s*,\s*["'][^"']+["']\s*\)/,
  /cookieParser\s*\(\s*["'][^"']+["']\s*\)/,
  /process\.env\.(?:JWT_SECRET|NEXTAUTH_SECRET|AUTH0_SECRET|SESSION_SECRET|CLERK_SECRET_KEY|COOKIE_SECRET)\s*(?:\|\||\?\?)\s*["'][^"']+["']/,
  /(?:const|let|var)\s+(?:JWT_SECRET|NEXTAUTH_SECRET|AUTH0_SECRET|SESSION_SECRET|CLERK_SECRET_KEY|COOKIE_SECRET)\s*=\s*["'][^"']+["']/,
];

const EXCLUDED_PATH_PARTS = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  'test', 'tests', '__tests__', 'fixtures', 'e2e', 'playground', 'benchmark',
  'examples', 'docs', 'public', '.cache', '.turbo', 'storybook-static', '.vercel',
  'generated', 'tmp', 'temp', '.husky', '.github', '.vscode', '.storybook',
];

const isSourceFile = (p) => {
  if (!isFile(p)) return false;
  if (!/\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p)) return false;
  if (p.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p)) return false;
  const parts = p.split('/');
  return !parts.some(part => EXCLUDED_PATH_PARTS.includes(part));
};

const scoreFile = (p) => {
  const lower = p.toLowerCase();
  let score = 0;
  if (/auth/.test(lower)) score += 3;
  if (/config/.test(lower)) score += 2;
  if (/secret|jwt|session|passport|login|oauth|token|middleware|crypto|cookie/.test(lower)) score += 1;
  return score;
};

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    const deps = {
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
      ...(packageJson?.peerDependencies || {}),
      ...(packageJson?.optionalDependencies || {}),
    };

    const foundAuth = [];
    for (const { pkg, name } of AUTH_PACKAGES) {
      if (deps[pkg]) foundAuth.push({ pkg, name });
    }
    for (const { prefix, name } of AUTH_PREFIXES) {
      for (const pkg of Object.keys(deps)) {
        if (pkg.startsWith(prefix) && !foundAuth.some(f => f.pkg === pkg)) {
          foundAuth.push({ pkg, name });
        }
      }
    }

    if (foundAuth.length === 0) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'No authentication detected', findings: [] };
    }

    const providerName = foundAuth[0].name;

    const envNames = ['.env.example', '.env.local.example', '.env.template', '.env.sample'];
    const envCandidates = tree.filter(p => isFile(p) && envNames.some(n => p.endsWith(n)));
    const expectedVars = ENV_VARS_BY_PROVIDER[providerName] || [];
    let hasEnvExample = false;
    let foundVars = [];

    for (const envFile of envCandidates.slice(0, 3)) {
      try {
        const content = await files.get(envFile);
        if (!content) continue;
        hasEnvExample = true;
        for (const v of expectedVars) {
          if (content.includes(v) && !foundVars.includes(v)) foundVars.push(v);
        }
        if (foundVars.length >= expectedVars.length) break;
      } catch (e) {
        console.error(`auth-config: error reading ${envFile}:`, e);
      }
    }

    const candidates = tree.filter(isSourceFile);
    const priority = [];
    const rest = [];
    const priorityRe = /(^|\/)(auth|config|session|jwt|secret|passport|middleware|login|oauth|signin|signup|token|guard|protect|crypto|cookie)/i;

    for (const p of candidates) {
      if (priorityRe.test(p)) priority.push(p);
      else rest.push(p);
    }

    priority.sort((a, b) => scoreFile(b) - scoreFile(a));
    const scanFiles = priority.concat(rest).slice(0, 30);
    const findings = [];

    for (const filePath of scanFiles) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

          for (const pat of DANGEROUS_PATTERNS) {
            if (pat.test(line)) {
              findings.push({ file: filePath, line: i + 1, issue: 'Auth secret hardcoded in source code — move to env var' });
              break;
            }
          }
        }
      } catch (e) {
        console.error(`auth-config: error reading ${filePath}:`, e);
      }
    }

    if (findings.length > 0) {
      return { checkId, status: 'fail', confidence: 'high', message: 'Auth secret key hardcoded — move to env var immediately', findings };
    }

    if (hasEnvExample && (expectedVars.length === 0 || foundVars.length > 0)) {
      const missing = expectedVars.filter(v => !foundVars.includes(v));
      if (missing.length === 0) {
        const hint = DASHBOARD_HINTS[providerName] || `Add new domain to ${providerName} allowed origins`;
        return { checkId, status: 'pass', confidence: 'high', message: `Auth configured: ${providerName}. ${hint}`, findings: [] };
      }
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: `Auth configured: ${providerName} but env example missing vars: ${missing.join(', ')}`,
        findings: missing.map(v => ({ file: envCandidates[0] || '.env.example', issue: `Missing expected env var: ${v}` }))
      };
    }

    if (!hasEnvExample) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: `Auth detected but no .env.example — create one with ${providerName} env vars`,
        findings: [{ file: 'package.json', issue: `Auth package ${foundAuth[0].pkg} detected but no .env.example found in repo` }]
      };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'Auth detected but env vars not fully documented',
      findings: [{ file: 'package.json', issue: `Auth package ${foundAuth[0].pkg} detected but expected env vars not found in .env.example` }]
    };
  } catch (err) {
    console.error('auth-config check error:', err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [{ file: 'internal', issue: err.message }] };
  }
}