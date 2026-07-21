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

const REPLIT_ENV_VAR_PATTERN = /\b(?:REPLIT_\w+|REPL_IDENTITY|REPL_ID|REPL_DB_URL|REPL_IMAGE|REPL_LANGUAGE|REPL_OWNER|REPL_PUBKEYS|REPL_SLUG|REPL_URL|REPL_USERNAME|WEB_REPL_RENEWAL|AI_INTEGRATIONS_\w+)\b/;

const REPLIT_API_PATTERN = /X-Replit-Token|connection\?connector_names=|replit\.com\/api\//i;

const REPLIT_CONFIG_CRITICAL_PATTERN = /defaultBucket|ghp_[A-Za-z0-9_]+/i;

const REPLIT_WORKSPACE_PATTERN = /@replit\/|stripe-replit-sync/i;

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

function isCommentLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/') ||
    trimmed.startsWith('<!--') ||
    trimmed.startsWith('--') ||
    trimmed.startsWith(';')
  );
}

function getMatchLines(content, pattern) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const matched = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!pattern.test(line)) continue;
    if (isCommentLine(line)) continue;
    matched.push(i + 1);
  }
  return matched;
}

function hasPatternInNonCommentLines(content, pattern) {
  if (!content) return false;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    if (isCommentLine(line)) continue;
    return true;
  }
  return false;
}

function filePriority(p) {
  let score = 0;
  const lower = p.toLowerCase();
  if (/replit/.test(lower)) score += 100;
  if (/(?:auth|identity)/.test(lower)) score += 60;
  if (/(?:billing|payment|stripe|connector)/.test(lower)) score += 60;
  if (/(?:ai|llm|openai|anthropic)/.test(lower)) score += 50;
  if (/(?:integration|connector)/.test(lower)) score += 50;
  if (/(?:config|settings)/.test(lower)) score += 40;
  if (/(?:server|api|middleware|route|controller|handler)/.test(lower)) score += 30;
  if (/(?:env|secret|credential|token)/.test(lower)) score += 30;
  score -= p.split('/').length * 2;
  return score;
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

    const findings = [];
    let hasCritical = false;

    // Root package.json dependencies
    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    for (const { pkg, replacement } of REPLIT_PACKAGES) {
      if (deps[pkg]) {
        findings.push({ file: 'package.json', issue: `${pkg} detected — ${replacement}` });
        hasCritical = true;
      }
    }

    // ALL sub-package.json files (bounded)
    const subPkgPaths = tree.filter(p =>
      isFile(p) &&
      p.endsWith('package.json') &&
      !isExcludedPath(p) &&
      p !== 'package.json'
    ).slice(0, 20);

    for (const subPkgPath of subPkgPaths) {
      try {
        const content = await files.get(subPkgPath);
        if (!content) continue;
        const sub = JSON.parse(content);
        const subDeps = { ...(sub.dependencies || {}), ...(sub.devDependencies || {}) };
        for (const { pkg, replacement } of REPLIT_PACKAGES) {
          if (subDeps[pkg]) {
            findings.push({ file: subPkgPath, issue: `${pkg} detected — ${replacement}` });
            hasCritical = true;
          }
        }
      } catch (e) {
        console.error(`platform-lock-in: error reading ${subPkgPath}:`, e);
      }
    }

    const hasReplitConfig = tree.includes('.replit') || tree.includes('replit.nix');

    // .replit config
    if (tree.includes('.replit')) {
      try {
        const replitContent = await files.get('.replit');
        if (replitContent) {
          const isCritical =
            hasPatternInNonCommentLines(replitContent, REPLIT_CONFIG_CRITICAL_PATTERN) ||
            hasPatternInNonCommentLines(replitContent, /\bintegrations\b/i) ||
            hasPatternInNonCommentLines(replitContent, /\bagent\b/i);
          if (isCritical) {
            hasCritical = true;
            findings.push({ file: '.replit', issue: 'Replit config contains managed integrations, resources, or secrets — critical lock-in' });
          } else {
            findings.push({ file: '.replit', issue: 'Replit config file detected — remove after migrating env vars and dependencies' });
          }
        }
      } catch (e) {
        console.error('platform-lock-in: error reading .replit:', e);
        findings.push({ file: '.replit', issue: 'Replit config file detected — remove after migrating env vars and dependencies' });
      }
    }

    if (tree.includes('replit.nix')) {
      findings.push({ file: 'replit.nix', issue: 'Replit nix config detected — remove after migrating dependencies to standard package management' });
    }

    // pnpm-workspace.yaml / .yml
    const pnpmPath = tree.includes('pnpm-workspace.yaml') ? 'pnpm-workspace.yaml' :
                     tree.includes('pnpm-workspace.yml') ? 'pnpm-workspace.yml' : null;
    if (pnpmPath) {
      try {
        const pnpmContent = await files.get(pnpmPath);
        if (pnpmContent && hasPatternInNonCommentLines(pnpmContent, REPLIT_WORKSPACE_PATTERN)) {
          findings.push({ file: pnpmPath, issue: 'Workspace config references Replit-specific packages or exemptions — build portability risk' });
          hasCritical = true;
        }
      } catch (e) {
        console.error(`platform-lock-in: error reading ${pnpmPath}:`, e);
      }
    }

    // Scan source files for Replit-only environment variables and API patterns (up to 30 reads)
    const sourceFiles = tree
      .filter(looksLikeSourceFile)
      .sort((a, b) => filePriority(b) - filePriority(a))
      .slice(0, 30);

    for (const filePath of sourceFiles) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        const envMatches = getMatchLines(content, REPLIT_ENV_VAR_PATTERN);
        for (const line of envMatches) {
          findings.push({
            file: filePath,
            line,
            issue: 'Replit-specific environment variable or identity token referenced — app may only run on Replit',
          });
          hasCritical = true;
        }
        const apiMatches = getMatchLines(content, REPLIT_API_PATTERN);
        for (const line of apiMatches) {
          findings.push({
            file: filePath,
            line,
            issue: 'Replit-specific API or connector token usage detected — hard platform coupling',
          });
          hasCritical = true;
        }
      } catch (e) {
        console.error(`platform-lock-in: error reading ${filePath}:`, e);
      }
    }

    if (hasCritical) {
      return {
        checkId,
        status: 'fail',
        confidence: 'high',
        message: `${findings.length} Replit-specific platform lock-in signal(s) found — must be decoupled before migrating`,
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