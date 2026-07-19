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

const isFile = (p) => !p.endsWith('/');

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    // Empty repo — nothing to check
    if (repoType === 'empty') {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Empty repo — no platform lock-in to check',
        findings: [],
      };
    }

    // Step 1: Tree-level check for Replit config files (zero file reads)
    const hasReplitConfig = tree.includes('.replit') || tree.includes('replit.nix');

    // Step 2: Root package.json dependencies (zero file reads — already parsed)
    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const found = [];
    for (const { pkg, replacement } of REPLIT_PACKAGES) {
      if (deps[pkg]) found.push({ pkg, replacement });
    }

    // Step 3: Workspace sub-packages (up to 10 file reads)
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
      } catch (e) { /* skip unreadable or invalid sub-package */ }
    }

    // Step 4: Build findings — dependency findings first, config files last
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

    // Decision matrix
    if (found.length >= 1) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: `${found.length} Replit-specific dependencies found — must be replaced before migrating`,
        findings,
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
