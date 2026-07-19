/**
 * Specialist: Platform Lock-in Check
 * Detects Replit-specific dependencies and configurations that prevent
 * deployment on other platforms, and suggests a replacement for each.
 */

export const checkId = 'platform-lock-in';
export const name = 'Platform Lock-in Check';
export const appliesTo = ['all'];

const REPLIT_PACKAGES = [
  { pkg: 'stripe-replit-sync', replacement: 'Use stripe npm package directly + build your own webhook handler' },
  { pkg: '@replit/vite-plugin-cartographer', replacement: 'Remove — Replit-only dev tool' },
  { pkg: '@replit/vite-plugin-dev-banner', replacement: 'Remove — Replit-only dev tool' },
  { pkg: '@replit/vite-plugin-runtime-error-modal', replacement: 'Remove — Replit-only dev tool' },
  { pkg: '@replit/vite-plugin-shadcn-theme-json', replacement: 'Move theme config to standard CSS/JSON file' },
  { pkg: '@replit/repl-auth', replacement: 'Use Clerk, NextAuth, or Firebase Auth' },
  { pkg: 'replit-auth', replacement: 'Use Clerk, NextAuth, or Firebase Auth' },
  { pkg: '@replit/object-storage', replacement: 'Use Cloudflare R2 (@aws-sdk/client-s3) or AWS S3' },
  { pkg: '@replit/ai', replacement: 'Use openai or @anthropic-ai/sdk directly' },
  { pkg: 'replit-ai', replacement: 'Use openai or @anthropic-ai/sdk directly' },
  { pkg: '@replit/ai-modelfarm', replacement: 'Use openai or @anthropic-ai/sdk directly' },
  { pkg: '@replit/database', replacement: 'Use PostgreSQL, Redis, or MongoDB' },
  { pkg: '@replit/protocol', replacement: 'Remove — internal Replit protocol' },
];

const REPLIT_ENV_VAR_PATTERN = /\b(?:REPLIT_\w+|REPL_ID|REPL_DB_URL|REPL_IMAGE|REPL_LANGUAGE|REPL_OWNER|REPL_PUBKEYS|REPL_SLUG|REPL_URL|REPL_USERNAME)\b/;

const EXCLUDED_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  'out/',
  'coverage/',
  'vendor/',
  '.cache/',
  '.turbo/',
];

const CODE_EXTENSIONS = /\.(?:js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|php|cs|swift|c|cpp|h|hpp|sh|bash|zsh|yaml|yml|toml)$/i;
const SPECIAL_FILES = /(?:^|\/)(?:Dockerfile|dockerfile|\.env(?:\.|$))$/i;
const GENERATED_OR_LOCK = /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|gemfile\.lock|cargo\.lock|podfile\.lock|packages\.lock\.json|\.min\.js|\.bundle\.js|\.map)$/i;

const isFile = (p) => !p.endsWith('/');

function isExcludedPath(p) {
  const lower = p.toLowerCase();
  for (const prefix of EXCLUDED_PREFIXES) {
    if (lower.includes(prefix)) return true;
  }
  return false;
}

function looksLikeSourceFile(p) {
  if (!isFile(p) || isExcludedPath(p) || GENERATED_OR_LOCK.test(p)) return false;
  if (SPECIAL_FILES.test(p)) return true;
  return CODE_EXTENSIONS.test(p);
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    if (repoType === 'empty') {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Empty repo — no platform lock-in to check',
        findings: [],
      };
    }

    const hasReplitConfig = tree.includes('.replit') || tree.includes('replit.nix');

    // Root package.json dependencies
    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const found = [];
    for (const { pkg, replacement } of REPLIT_PACKAGES) {
      if (deps[pkg]) found.push({ pkg, replacement });
    }

    // Workspace sub-packages (up to 10 file reads)
    const subPkgs = tree.filter(p => isFile(p) && /^(?:apps|packages)\/[^/]+\/package\.json$/.test(p));
    for (const subPkgPath of subPkgs.slice(0, 10)) {
      try {
        const content = await files.get(subPkgPath);
        if (!content) continue;
        const sub = JSON.parse(content);
        const subDeps = { ...(sub.dependencies || {}), ...(sub.devDependencies || {}) };
        for (const { pkg, replacement } of REPLIT_PACKAGES) {
          if (subDeps[pkg]) found.push({ pkg, replacement, inPackage: subPkgPath });
        }
      } catch (e) {
        console.error(`platform-lock-in: error reading ${subPkgPath}:`, e);
      }
    }

    const findings = [];
    for (const f of found) {
      findings.push({
        file: f.inPackage || 'package.json',
        issue: `${f.pkg} detected — ${f.replacement}`,
      });
    }
    if (tree.includes('.replit')) {
      findings.push({ file: '.replit', issue: 'Replit config file detected — remove after migrating env vars and dependencies' });
    }
    if (tree.includes('replit.nix')) {
      findings.push({ file: 'replit.nix', issue: 'Replit nix config detected — remove after migrating dependencies to standard package management' });
    }

    if (found.length >= 1) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: `${found.length} Replit-specific dependencies found — must be replaced before migrating`,
        findings,
      };
    }

    // Scan source files for Replit-only environment variables (up to 30 reads)
    const sourceFiles = tree
      .filter(looksLikeSourceFile)
      .sort((a, b) => {
        const depthA = a.split('/').length;
        const depthB = b.split('/').length;
        if (depthA !== depthB) return depthA - depthB;
        return a.localeCompare(b);
      })
      .slice(0, 30);

    const envFindings = [];
    for (const filePath of sourceFiles) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        if (REPLIT_ENV_VAR_PATTERN.test(content)) {
          envFindings.push({
            file: filePath,
            issue: 'Replit-specific environment variable referenced — app may only run on Replit',
          });
        }
      } catch (e) {
        console.error(`platform-lock-in: error reading ${filePath}:`, e);
      }
    }

    if (envFindings.length > 0) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: `${envFindings.length} Replit-specific environment variable reference(s) found — must be decoupled before migrating`,
        findings: envFindings,
      };
    }

    if (hasReplitConfig) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: '.replit config present — verify no hidden Replit dependencies',
        findings,
      };
    }

    if (packageJson) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: 'No Replit lock-in detected',
        findings: [],
      };
    }

    return {
      checkId,
      status: 'not-applicable',
      confidence: 'medium',
      message: 'No package.json — platform lock-in check not applicable',
      findings: [],
    };
  } catch (err) {
    console.error('platform-lock-in check error:', err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error: ${err.message}`,
      findings: [{ file: 'internal', issue: `Fatal error: ${err.message}` }],
    };
  }
}