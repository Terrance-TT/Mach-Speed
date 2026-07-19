// specialists/authentication-configuration.js — Detects auth config (Clerk, Firebase, NextAuth, Auth0...) and checks
// if it's externalized to env vars. Auth breaks on domain changes — each platform needs the new domain.
export const checkId = 'auth-config';
export const name = 'Authentication Configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

const isFile = (p) => !p.endsWith('/');

const AUTH_PACKAGES = [
  { pkg: '@clerk/clerk-react', name: 'Clerk' },
  { pkg: '@clerk/nextjs', name: 'Clerk' },
  { pkg: '@clerk/clerk-sdk-node', name: 'Clerk' },
  { pkg: '@clerk/expo', name: 'Clerk' },
  { pkg: '@clerk/astro', name: 'Clerk' },
  { pkg: 'next-auth', name: 'NextAuth' },
  { pkg: '@auth/core', name: 'Auth.js' },
  { pkg: '@auth/nextjs', name: 'Auth.js' },
  { pkg: 'firebase', name: 'Firebase Auth' },
  { pkg: '@auth0/nextjs-auth0', name: 'Auth0' },
  { pkg: '@supabase/supabase-js', name: 'Supabase Auth' },
  { pkg: '@supabase/auth-helpers-nextjs', name: 'Supabase Auth' },
  { pkg: 'passport', name: 'Passport.js' },
  { pkg: 'jsonwebtoken', name: 'Custom JWT' },
  { pkg: 'jose', name: 'Custom JWT' },
  { pkg: 'jwt-decode', name: 'Custom JWT' },
];

const ENV_VARS_BY_PROVIDER = {
  'Clerk': ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY'],
  'NextAuth': ['NEXTAUTH_URL', 'NEXTAUTH_SECRET'],
  'Firebase Auth': ['NEXT_PUBLIC_FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID'],
  'Auth0': ['AUTH0_SECRET', 'AUTH0_BASE_URL', 'AUTH0_ISSUER_BASE_URL', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'],
  'Supabase Auth': ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  'Passport.js': ['SESSION_SECRET'],
  'Custom JWT': ['JWT_SECRET'],
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
  /CLERK_SECRET_KEY\s*[:=]\s*["']sk_/,       // Clerk secret in code
  /jwt\.sign\s*\([^,]+,\s*["'][^"']+["']/,   // JWT secret as string literal
  /AUTH0_SECRET\s*[:=]\s*["']/,              // Auth0 secret hardcoded
  /SESSION_SECRET\s*[:=]\s*["'][^"']{8,}/,   // Session secret hardcoded
];

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    // Step 1: tree-level check — auth packages in package.json (zero file reads)
    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const foundAuth = [];
    for (const { pkg, name } of AUTH_PACKAGES) {
      if (deps[pkg]) foundAuth.push({ pkg, name });
    }

    if (foundAuth.length === 0) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'No authentication detected', findings: [] };
    }

    const providerName = foundAuth[0].name;

    // Step 2: check for env var documentation (up to 3 file reads, stop early)
    const envFiles = ['.env.example', '.env.local.example', '.env.template'];
    const expectedVars = ENV_VARS_BY_PROVIDER[providerName] || [];
    let hasEnvExample = false;
    let foundVars = [];

    for (const envFile of envFiles) {
      if (!tree.includes(envFile)) continue;
      try {
        const content = await files.get(envFile);
        if (!content) continue;
        hasEnvExample = true;
        for (const v of expectedVars) if (content.includes(v)) foundVars.push(v);
        break; // found one, stop
      } catch (e) { /* skip */ }
    }

    // Step 3: scan up to 10 source files for hardcoded auth secrets
    const sourceFiles = tree.filter(p => {
      if (!isFile(p)) return false;
      if (!/\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p)) return false;
      if (/node_modules/.test(p)) return false;
      if (/\.test\./.test(p)) return false;
      if (/\.spec\./.test(p)) return false;
      return /^(src|app|lib|api|pages|middleware)/.test(p) || !p.includes('/');
    }).slice(0, 10);

    const findings = [];
    for (const filePath of sourceFiles) {
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
      } catch (e) { /* skip */ }
    }

    // Decision matrix
    if (findings.length > 0) {
      return { checkId, status: 'fail', confidence: 'high', message: 'Auth secret key hardcoded — move to env var immediately', findings };
    }

    if (hasEnvExample && foundVars.length > 0) {
      const hint = DASHBOARD_HINTS[providerName] || `Add new domain to ${providerName} allowed origins`;
      const envFindings = foundVars.map(v => ({ file: '.env.example', issue: `${v} documented` }));
      return { checkId, status: 'pass', confidence: 'high', message: `Auth configured: ${providerName}. ${hint}`, findings: envFindings };
    }

    if (!hasEnvExample) {
      return { checkId, status: 'check-it', confidence: 'medium', message: `Auth detected but no .env.example — create one with ${providerName} env vars`, findings: [] };
    }

    return { checkId, status: 'check-it', confidence: 'medium', message: 'Auth detected but no env var documentation found', findings: [] };

  } catch (err) {
    console.error('auth-config check error:', err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [{ file: 'internal', issue: err.message }] };
  }
}
