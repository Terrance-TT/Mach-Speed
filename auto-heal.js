#!/usr/bin/env node
// auto-heal.js — v2: Test specialists against public repos, detect holistic patterns, generate evidence
// Usage: node auto-heal.js [--output ./evidence] [--repos extra-repos.json]
//
// This script tests the Mach-Speed specialist suite against a diverse set of public repos,
// then generates HOLISTIC evidence per specialist — identifying systematic patterns, not
// repo-specific bugs. The evidence is designed to be pasted directly into Kimi chats for
// specialist improvement.
//
// v2 improvements (holistic fixes):
//  - DATA-INTEGRITY GATE: refuses to declare "all clear" when too many repos errored.
//    Incomplete runs are loudly marked INCOMPLETE in console, README.md and report.json.
//  - AUTH + RESILIENCE: uses GITHUB_TOKEN/GH_TOKEN when present (60 -> 5000 req/hr),
//    retries 403/429/5xx with exponential backoff and honors rate-limit reset headers.
//    Implemented as a fetch middleware so NO other module needs to change.
//  - IMPORTABLE: all analysis functions are exported; the CLI only runs when executed
//    directly, so the pattern engine can be reused and unit-tested.
//  - --repos flag is now actually implemented (was documented but ignored).
//  - Repo-type-bias detector no longer counts CORRECT "not-applicable" results against
//    specialists (was producing guaranteed false bias flags on type-scoped checks).
//  - Classifier drift report: compares actual repoType vs expected per repo, because
//    misclassification silently corrupts every downstream specialist conclusion.
//  - Markdown escaping in evidence tables (pipes/newlines in messages no longer corrupt them).
//  - Per-repo timeout so one hanging repo can't stall the whole run.

import { RepoType, SPECIALIST_REGISTRY } from './contract.js';
import { analyzeRepo } from './central.js';
import { prefetchRepos, createCachedFetch, pool, REPO_CACHE_ENV } from './repo-cache.js';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tuning knobs ──
const MIN_REPO_COVERAGE = 0.6;      // need >=60% of repos to succeed, else run is INCOMPLETE
const MIN_SPECIALIST_RESULTS = 5;   // need >=5 results before pattern detection is trustworthy
const REPO_TIMEOUT_MS = 240_000;    // max time to analyze a single repo
const ANALYSIS_CONCURRENCY = 6;     // repos analyzed in parallel (snapshots make this cheap)
const FETCH_MAX_RETRIES = 4;
const FETCH_BASE_DELAY_MS = 1_000;
const RATE_LIMIT_WAIT_CAP_MS = 60_000; // never sleep more than 60s waiting for a rate-limit reset

// ── Fetch middleware: auth + retry, installed once, benefits every module that fetches ──
export function installFetchMiddleware({
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  maxRetries = FETCH_MAX_RETRIES,
  baseDelayMs = FETCH_BASE_DELAY_MS,
  verbose = true,
} = {}) {
  if (globalThis.__machSpeedFetchPatched) return { token };
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts = {}) => {
    // Only GitHub API calls get auth + retry treatment. Other services (e.g.
    // Moonshot) have their own clients with their own backoff — stacking a
    // second retry layer on top turns one 429 into a request storm.
    if (typeof url !== 'string' || !url.includes('api.github.com')) {
      return origFetch(url, opts);
    }
    const headers = { ...(opts.headers || {}) };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    }

    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await origFetch(url, { ...opts, headers });
      } catch (err) {
        attempt++;
        if (attempt > maxRetries) throw err;
        const wait = baseDelayMs * 2 ** attempt;
        if (verbose) console.warn(`    [fetch] network error (${err.message}); retry ${attempt}/${maxRetries} in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
      if (!retryable) return res;

      attempt++;
      if (attempt > maxRetries) return res; // out of retries — let caller see the raw status

      let wait = baseDelayMs * 2 ** attempt;
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      if (remaining === '0' && reset) {
        // Hard rate limit: wait until reset (capped) instead of pointlessly hammering.
        wait = Math.min(Math.max(0, Number(reset) * 1000 - Date.now()) + 1_000, RATE_LIMIT_WAIT_CAP_MS);
      }
      if (verbose) console.warn(`    [fetch] HTTP ${res.status} for ${url}; retry ${attempt}/${maxRetries} in ${wait}ms`);
      await sleep(wait);
    }
  };

  // Repo snapshot cache: when MACH_SPEED_REPO_CACHE points at a directory of
  // prefetched tarballs, trees/raw/metadata are served from disk — no network.
  const cacheDir = process.env[REPO_CACHE_ENV];
  if (cacheDir) {
    // absolute, so child runner processes resolve the same directory regardless of cwd
    const absCache = path.resolve(cacheDir);
    globalThis.fetch = createCachedFetch(absCache, globalThis.fetch);
    if (verbose) console.log(`    [fetch] repo snapshot cache active: ${absCache}`);
  }

  globalThis.__machSpeedFetchPatched = true;
  return { token };
}

// ── Expanded test suite — diverse repo types for holistic testing ──
export const TEST_REPOS = [
  // ── Libraries (no deployment needed) ──
  { owner: 'facebook',      repo: 'react',           expected: 'library',     tags: ['library', 'ui', 'peer-deps'] },
  { owner: 'lodash',        repo: 'lodash',          expected: 'library',     tags: ['library', 'utility', 'no-framework'] },
  { owner: 'microsoft',     repo: 'TypeScript',      expected: 'library',     tags: ['library', 'compiler', 'complex-build'] },

  // ── Deployable apps (should deploy cleanly) ──
  { owner: 'nodejs',        repo: 'nodejs.org',      expected: 'deployable',  tags: ['deployable', 'nextjs', 'website'] },
  { owner: 'withastro',     repo: 'astro',           expected: 'deployable',  tags: ['deployable', 'astro', 'docs-site'] },
  { owner: 'calcom',        repo: 'cal.com',         expected: 'deployable',  tags: ['deployable', 'nextjs', 'monorepo', 'complex'] },
  { owner: 'vercel',        repo: 'next-learn',      expected: 'deployable',  tags: ['deployable', 'nextjs', 'tutorial', 'simple'] },

  // ── Server frameworks (need runtime config) ──
  { owner: 'expressjs',     repo: 'express',         expected: 'framework',   tags: ['server', 'framework', 'minimalist'] },
  { owner: 'fastify',       repo: 'fastify',         expected: 'framework',   tags: ['server', 'framework', 'plugin-system'] },

  // ── Meta-frameworks (complex, many concerns) ──
  { owner: 'vercel',        repo: 'next.js',         expected: 'framework',   tags: ['framework', 'meta-framework', 'monorepo', 'very-complex'] },
  { owner: 'nuxt',          repo: 'nuxt',            expected: 'framework',   tags: ['framework', 'meta-framework', 'monorepo'] },
  { owner: 'supabase',      repo: 'supabase',        expected: 'framework',   tags: ['framework', 'platform', 'monorepo', 'very-complex'] },
  { owner: 'sveltejs',      repo: 'kit',             expected: 'framework',   tags: ['framework', 'meta-framework', 'deployer'] },

  // ── Tools/CLIs (not deployable) ──
  { owner: 'vercel',        repo: 'turbo',           expected: 'tool',        tags: ['tool', 'cli', 'monorepo'] },
  { owner: 'webpack',       repo: 'webpack',         expected: 'tool',        tags: ['tool', 'bundler', 'complex-build'] },
];

// ── Known signal patterns for holistic detection ──
export const HOLISTIC_PATTERNS = {
  OVER_CAUTIOUS: {
    id: 'over-cautious',
    title: 'Over-Cautious Default',
    description: 'Returns "check-it" as the default/fallback outcome when signals are unclear. This creates alert fatigue — every repo needs manual review.',
    threshold: 0.40, // >40% check-it rate triggers this
    severity: 'high',
  },
  CONFIDENCE_INCONSISTENCY: {
    id: 'confidence-inconsistency',
    title: 'Confidence Inconsistency',
    description: 'Returns "high" confidence alongside "check-it" status, or "low" confidence alongside a definitive pass/fail. Confidence should reflect certainty in the conclusion.',
    threshold: 1, // any occurrence triggers this
    severity: 'medium',
  },
  SILENT_ERRORS: {
    id: 'silent-errors',
    title: 'Silent Error Swallowing',
    description: 'Catch blocks return "check-it" without logging or surfacing the actual error. This hides real bugs (e.g., file read failures) behind a seemingly-safe status.',
    threshold: 1,
    severity: 'high',
  },
  FALSE_POSITIVE: {
    id: 'false-positive',
    title: 'False Positive Pattern',
    description: 'Reports a finding/issue that is not actually a deployment concern for this repo type. This reduces trust in the tool.',
    threshold: 1,
    severity: 'medium',
  },
  NOT_APPLICABLE_CONFUSION: {
    id: 'na-confusion',
    title: 'Not-Applicable Confusion',
    description: 'Returns "not-applicable" but includes findings (contradictory), or returns "not-applicable" on repos where the check IS relevant.',
    threshold: 1,
    severity: 'medium',
  },
  MISSED_SIGNAL: {
    id: 'missed-signal',
    title: 'Missed Detection Signal',
    description: 'Fails to detect a clear deployment-readiness signal that is present in the repo (e.g., a start script exists but wasn\'t found, a health check endpoint is present but missed).',
    threshold: 1,
    severity: 'high',
  },
  REPO_TYPE_BIAS: {
    id: 'repo-type-bias',
    title: 'Repo-Type Detection Bias',
    description: 'Performs significantly better or worse on certain repo types, suggesting the detection logic is tuned for one type and fails on others. A robust specialist should work across all applicable repo types.',
    threshold: 0.30, // >30% variance in decisive pass rate between repo types
    severity: 'medium',
  },
  EMPTY_REPO_FAILURE: {
    id: 'empty-repo-failure',
    title: 'Empty Repo Guard Missing',
    description: 'Returns "fail" or crashes on empty/minimal repos instead of gracefully returning "not-applicable" or "pass".',
    threshold: 1,
    severity: 'medium',
  },
  MODERN_TOOL_GAP: {
    id: 'modern-tool-gap',
    title: 'Modern Tool Support Gap',
    description: 'Does not recognize modern tooling patterns (e.g., pnpm workspaces, Turborepo, Vite, Drizzle ORM, Cloudflare Workers, etc.) that are increasingly common in production repos.',
    threshold: 1,
    severity: 'low',
  },
};

// ── What each specialist should detect (ground truth for evaluation) ──
export const SPECIALIST_GROUND_TRUTH = {
  'start-script': {
    purpose: 'Detect if the repo has a start script in package.json for production deployment',
    shouldFind: (repo) => repo.tags.includes('deployable') || repo.tags.includes('server') || repo.tags.includes('framework'),
    positiveSignals: ['"start" script in package.json scripts', '"serve" script', '"start:prod" script', 'Procfile', 'Dockerfile with CMD'],
    negativeSignals: ['library with no server', 'tool/CLI package', 'no package.json'],
  },
  'build-step': {
    purpose: 'Detect if the repo has a build step and if it is configured correctly',
    shouldFind: (repo) => !repo.tags.includes('library') || repo.tags.includes('complex-build'),
    positiveSignals: ['"build" script', '"compile" script', 'tsconfig.json', 'webpack config', 'vite config'],
    negativeSignals: ['pure runtime library', 'no compilation needed'],
  },
  'dynamic-port': {
    purpose: 'Detect if the server uses process.env.PORT or a configurable port (not hardcoded)',
    shouldFind: (repo) => repo.tags.includes('server') || repo.tags.includes('framework'),
    positiveSignals: ['process.env.PORT', 'port configuration', 'listen(process.env.PORT)', 'PORT env var usage'],
    negativeSignals: ['static site', 'client-only app', 'hardcoded port 3000 without fallback'],
  },
  'host-binding': {
    purpose: 'Detect if the server binds to 0.0.0.0 or a configurable host (not localhost-only)',
    shouldFind: (repo) => repo.tags.includes('server') || repo.tags.includes('framework'),
    positiveSignals: ['0.0.0.0', 'HOST env var', 'process.env.HOST', 'host configuration'],
    negativeSignals: ['localhost-only binding', 'client-side app', 'static site'],
  },
  'health-check': {
    purpose: 'Detect if the repo has a health check endpoint or monitoring setup',
    shouldFind: (repo) => repo.tags.includes('server') || repo.tags.includes('framework') || repo.tags.includes('deployable'),
    positiveSignals: ['/health route', '/status endpoint', 'healthcheck middleware', 'readiness probe', 'liveness probe'],
    negativeSignals: ['static site', 'client-only library', 'no server code'],
  },
  'cors': {
    purpose: 'Detect if CORS is configured for cross-origin requests',
    shouldFind: (repo) => repo.tags.includes('server') || repo.tags.includes('api'),
    positiveSignals: ['cors middleware', 'Access-Control-Allow-Origin', 'cors package import'],
    negativeSignals: ['static site', 'no API endpoints', 'client-side only'],
  },
  'static-files': {
    purpose: 'Detect if static assets are properly served with caching headers',
    shouldFind: (repo) => repo.tags.includes('deployable') || repo.tags.includes('server') || repo.tags.includes('framework'),
    positiveSignals: ['express.static', 'serve-static', 'CDN config', 'asset prefix', 'public folder served'],
    negativeSignals: ['API-only server', 'no static assets'],
  },
  'secrets': {
    purpose: 'Detect if secrets or sensitive data are hardcoded in the codebase',
    shouldFind: () => true, // All repos should be checked
    positiveSignals: ['hardcoded API keys', 'passwords in source', '.env files committed', 'private keys in repo'],
    negativeSignals: ['legitimate config files', 'test fixtures', 'vendor bundles'],
    falsePositiveTriggers: ['.yarn/releases/', 'test fixtures', 'example configs', 'documentation'],
  },
  'env-vars': {
    purpose: 'Detect if environment variables are properly used and documented',
    shouldFind: (repo) => repo.tags.includes('deployable') || repo.tags.includes('server') || repo.tags.includes('framework'),
    positiveSignals: ['.env.example', 'process.env usage', 'environment docs', 'config validation'],
    negativeSignals: ['library', 'no env-dependent behavior'],
  },
  'node-version': {
    purpose: 'Detect if Node.js version is pinned (engines field, .nvmrc, etc.)',
    shouldFind: () => true,
    positiveSignals: ['engines.node in package.json', '.nvmrc', '.node-version', 'Dockerfile FROM node:'],
    negativeSignals: ['no version pinning'],
  },
  'lockfile': {
    purpose: 'Detect if a lockfile exists for reproducible installs',
    shouldFind: () => true,
    positiveSignals: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'],
    negativeSignals: ['no lockfile'],
  },
  'database-config': {
    purpose: 'Detect if database configuration is present and properly set up',
    shouldFind: (repo) => repo.tags.includes('deployable') || repo.tags.includes('server') || repo.tags.includes('framework'),
    positiveSignals: ['database connection string', 'prisma schema', 'drizzle config', 'ORM import'],
    negativeSignals: ['no database', 'static site', 'client-only app'],
  },
};

// ── Small helpers ──
function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error(`Timed out after ${Math.round(ms / 1000)}s (${label})`); }),
  ]);
}

// ── Pattern detection engine ──
export function detectPatterns(checkId, results, repoTypeMap, testRepos = TEST_REPOS) {
  const patterns = [];
  const specialistResults = results.filter(r => r.checkId === checkId);

  // Not enough data → no trustworthy patterns (caller reports this as insufficient-data)
  if (specialistResults.length < MIN_SPECIALIST_RESULTS) return patterns;

  const statuses = specialistResults.map(r => r.status);
  const total = statuses.length;
  const checkItCount = statuses.filter(s => s === 'check-it').length;
  const checkItRate = checkItCount / total;

  // Pattern 1: Over-cautious
  if (checkItRate > HOLISTIC_PATTERNS.OVER_CAUTIOUS.threshold) {
    const repoExamples = specialistResults
      .filter(r => r.status === 'check-it')
      .slice(0, 3)
      .map(r => `${r.owner}/${r.repo} (${r.repoType})`);
    patterns.push({
      ...HOLISTIC_PATTERNS.OVER_CAUTIOUS,
      evidence: `Returns "check-it" on ${checkItCount}/${total} repos (${(checkItRate * 100).toFixed(0)}%). Examples: ${repoExamples.join(', ')}`,
      frequency: checkItRate,
    });
  }

  // Pattern 2: Confidence inconsistency
  const inconsistent = specialistResults.filter(
    r => (r.confidence === 'high' && r.status === 'check-it') ||
         (r.confidence === 'low' && (r.status === 'pass' || r.status === 'fail'))
  );
  if (inconsistent.length >= HOLISTIC_PATTERNS.CONFIDENCE_INCONSISTENCY.threshold) {
    patterns.push({
      ...HOLISTIC_PATTERNS.CONFIDENCE_INCONSISTENCY,
      evidence: `${inconsistent.length} cases of mismatched confidence/status. Examples: ${inconsistent.slice(0, 2).map(r => `${r.owner}/${r.repo}: ${r.confidence} confidence + ${r.status}`).join('; ')}`,
      frequency: inconsistent.length / total,
    });
  }

  // Pattern 3: Not-applicable confusion
  const naWithFindings = specialistResults.filter(
    r => r.status === 'not-applicable' && r.findings && r.findings.length > 0
  );
  if (naWithFindings.length >= HOLISTIC_PATTERNS.NOT_APPLICABLE_CONFUSION.threshold) {
    patterns.push({
      ...HOLISTIC_PATTERNS.NOT_APPLICABLE_CONFUSION,
      evidence: `${naWithFindings.length} cases of "not-applicable" with findings array. A finding means something was detected — status should reflect that.`,
      frequency: naWithFindings.length / total,
    });
  }

  // Pattern 4: Silent error detection (indirect — high check-it + low findings)
  const highCheckItLowFindings = specialistResults.filter(
    r => r.status === 'check-it' && (!r.findings || r.findings.length === 0)
  );
  if (highCheckItLowFindings.length > total * 0.3) {
    patterns.push({
      ...HOLISTIC_PATTERNS.SILENT_ERRORS,
      evidence: `${highCheckItLowFindings.length} "check-it" results with ZERO findings — suggests catch-blocks are swallowing errors and returning safe defaults without real analysis.`,
      frequency: highCheckItLowFindings.length / total,
    });
  }

  // Pattern 5: Repo-type bias
  // Only DECISIVE results count (pass/fail/check-it). A correct "not-applicable" is the
  // specialist doing its job on out-of-scope repos — treating it as a 0% pass rate
  // manufactures fake bias on every type-scoped check.
  const byType = {};
  for (const r of specialistResults) {
    if (r.status === 'not-applicable') continue;
    if (!byType[r.repoType]) byType[r.repoType] = { pass: 0, total: 0 };
    byType[r.repoType].total++;
    if (r.status === 'pass') byType[r.repoType].pass++;
  }
  const qualifiedTypes = Object.entries(byType).filter(([, v]) => v.total >= 2);
  if (qualifiedTypes.length > 1) {
    const rates = qualifiedTypes.map(([, v]) => v.pass / v.total);
    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    if (maxRate - minRate > HOLISTIC_PATTERNS.REPO_TYPE_BIAS.threshold) {
      const typeDetails = qualifiedTypes
        .map(([type, v]) => `${type}: ${v.pass}/${v.total} pass`)
        .join(', ');
      patterns.push({
        ...HOLISTIC_PATTERNS.REPO_TYPE_BIAS,
        evidence: `Decisive pass rate varies significantly by repo type (not-applicable excluded): ${typeDetails}. Range: ${(minRate * 100).toFixed(0)}% - ${(maxRate * 100).toFixed(0)}%`,
        frequency: maxRate - minRate,
      });
    }
  }

  // Pattern 6: Missed signal (check-it when ground truth says it should find something)
  const groundTruth = SPECIALIST_GROUND_TRUTH[checkId];
  if (groundTruth) {
    const missed = specialistResults.filter(r => {
      const repo = testRepos.find(t => t.owner === r.owner && t.repo === r.repo);
      if (!repo) return false;
      const shouldFind = groundTruth.shouldFind(repo);
      return shouldFind && r.status === 'check-it';
    });
    if (missed.length >= HOLISTIC_PATTERNS.MISSED_SIGNAL.threshold) {
      patterns.push({
        ...HOLISTIC_PATTERNS.MISSED_SIGNAL,
        evidence: `${missed.length} cases where the check was relevant (repo has signals) but returned "check-it" instead of a definitive result. Examples: ${missed.slice(0, 2).map(r => `${r.owner}/${r.repo}`).join(', ')}`,
        frequency: missed.length / total,
      });
    }
  }

  // Pattern 7: False positive (fail on repos where check isn't really a concern)
  if (groundTruth) {
    const falsePos = specialistResults.filter(r => {
      const repo = testRepos.find(t => t.owner === r.owner && t.repo === r.repo);
      if (!repo) return false;
      const shouldFind = groundTruth.shouldFind(repo);
      return !shouldFind && r.status === 'fail';
    });
    if (falsePos.length >= HOLISTIC_PATTERNS.FALSE_POSITIVE.threshold) {
      patterns.push({
        ...HOLISTIC_PATTERNS.FALSE_POSITIVE,
        evidence: `${falsePos.length} "fail" results on repos where this check is not typically relevant. Examples: ${falsePos.slice(0, 2).map(r => `${r.owner}/${r.repo}`).join(', ')}`,
        frequency: falsePos.length / total,
      });
    }
  }

  return patterns;
}

// ── Generate holistic evidence markdown for a specialist ──
export function generateEvidence(checkId, patterns, allResults, repoTypeMap, testRepos = TEST_REPOS) {
  const specialistResults = allResults.filter(r => r.checkId === checkId);
  const groundTruth = SPECIALIST_GROUND_TRUTH[checkId];
  const registryEntry = SPECIALIST_REGISTRY[checkId];
  const insufficientData = specialistResults.length < MIN_SPECIALIST_RESULTS;

  const total = specialistResults.length;
  const statuses = {
    pass: specialistResults.filter(r => r.status === 'pass').length,
    fail: specialistResults.filter(r => r.status === 'fail').length,
    'check-it': specialistResults.filter(r => r.status === 'check-it').length,
    'not-applicable': specialistResults.filter(r => r.status === 'not-applicable').length,
  };

  // Build per-repo detail table
  const repoDetails = specialistResults.map(r => {
    const repo = testRepos.find(t => t.owner === r.owner && t.repo === r.repo);
    const shouldRun = registryEntry?.includes('all') || registryEntry?.includes(r.repoType);
    return {
      repo: `${r.owner}/${r.repo}`,
      type: r.repoType,
      expected: repo?.expected || '?',
      status: r.status,
      confidence: r.confidence,
      findings: r.findings?.length || 0,
      shouldRun: shouldRun ? 'yes' : 'NO',
      message: r.message?.substring(0, 120) || '',
    };
  });

  // Sort by status (fails first, then check-its)
  repoDetails.sort((a, b) => {
    const order = { fail: 0, 'check-it': 1, pass: 2, 'not-applicable': 3 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  const md = [`# Evidence for \`${checkId}\` Specialist`, ''];

  if (insufficientData) {
    md.push(`> ⚠️ **INSUFFICIENT DATA** — this specialist only produced ${total} result(s) (minimum trustworthy: ${MIN_SPECIALIST_RESULTS}).`);
    md.push(`> Too many repos failed to analyze this run. Do NOT draw conclusions from the pattern section — re-run auto-heal (with a GITHUB_TOKEN set) before fixing anything.`);
    md.push('');
  }

  md.push(`## What This Specialist Should Detect`);
  md.push('');
  if (groundTruth) {
    md.push(`**Purpose:** ${groundTruth.purpose}`);
    md.push('');
    md.push('**Positive signals (should detect):**');
    for (const s of groundTruth.positiveSignals) md.push(`- ${s}`);
    md.push('');
    md.push('**Negative signals (should ignore):**');
    for (const s of groundTruth.negativeSignals) md.push(`- ${s}`);
  } else {
    md.push(`No ground truth defined for this specialist.`);
  }
  md.push('');

  md.push(`## Current Behavior Stats`);
  md.push('');
  md.push(`Tested against **${total}** repos:`);
  md.push(`- PASS: ${statuses.pass} (${total ? ((statuses.pass / total) * 100).toFixed(0) : 0}%)`);
  md.push(`- FAIL: ${statuses.fail} (${total ? ((statuses.fail / total) * 100).toFixed(0) : 0}%)`);
  md.push(`- CHECK-IT: ${statuses['check-it']} (${total ? ((statuses['check-it'] / total) * 100).toFixed(0) : 0}%)`);
  md.push(`- NOT-APPLICABLE: ${statuses['not-applicable']} (${total ? ((statuses['not-applicable'] / total) * 100).toFixed(0) : 0}%)`);
  md.push('');
  md.push(`**Registered for repo types:** ${registryEntry?.join(', ') || 'NOT IN REGISTRY'}`);
  md.push('');

  if (insufficientData) {
    md.push(`## Pattern Detection Skipped (insufficient data)`);
    md.push('');
    md.push(`Pattern detection requires at least ${MIN_SPECIALIST_RESULTS} results to avoid drawing conclusions from noise.`);
    md.push('');
  } else if (patterns.length > 0) {
    md.push(`## Holistic Problems Detected (${patterns.length})`);
    md.push('');
    md.push(`> These are **systematic patterns** observed across multiple repos. Fixing these will improve behavior for ALL repos, not just the examples listed.`);
    md.push('');

    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      md.push(`### ${i + 1}. ${p.title} [${p.severity.toUpperCase()}]`);
      md.push('');
      md.push(p.description);
      md.push('');
      md.push(`**Evidence:** ${p.evidence}`);
      md.push(`**Frequency:** ${(p.frequency * 100).toFixed(0)}% of tested repos`);
      md.push('');
    }
  } else {
    md.push(`## No Holistic Problems Detected`);
    md.push('');
    md.push(`This specialist is performing well across the test suite (${total} repos). No systematic patterns of failure were found.`);
    md.push('');
  }

  md.push(`## Per-Repo Results`);
  md.push('');
  md.push(`| Repo | Type | Status | Confidence | Findings | Should Run | Message |`);
  md.push(`|------|------|--------|------------|----------|------------|---------|`);
  for (const d of repoDetails) {
    md.push(`| ${mdCell(d.repo)} | ${mdCell(d.type)} | ${mdCell(d.status)} | ${mdCell(d.confidence)} | ${d.findings} | ${d.shouldRun} | ${mdCell(d.message)} |`);
  }
  md.push('');

  md.push(`---`);
  md.push(`*Generated by auto-heal.js — Mach-Speed diagnostic tool*`);
  md.push(`*This evidence is HOLISTIC: it describes patterns across ALL repos, not fixes for specific ones.*`);

  return md.join('\n');
}

// ── Main execution ──
export async function autoheal(argv = process.argv.slice(2)) {
  const args = argv;
  const outputDir = args.includes('--output') ? args[args.indexOf('--output') + 1] : './evidence';

  // --repos extra-repos.json : merge additional repos into the test suite (dedupe by owner/repo)
  let testRepos = [...TEST_REPOS];
  if (args.includes('--repos')) {
    const extraPath = args[args.indexOf('--repos') + 1];
    try {
      const extra = JSON.parse(fs.readFileSync(extraPath, 'utf8'));
      if (!Array.isArray(extra)) throw new Error('expected a JSON array of {owner, repo, expected?, tags?}');
      const seen = new Set(testRepos.map(r => `${r.owner}/${r.repo}`));
      let added = 0;
      for (const r of extra) {
        if (!r.owner || !r.repo) continue;
        const key = `${r.owner}/${r.repo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        testRepos.push({ owner: r.owner, repo: r.repo, expected: r.expected || 'unknown', tags: r.tags || [] });
        added++;
      }
      console.log(`  Loaded ${added} extra repo(s) from ${extraPath}`);
    } catch (err) {
      console.error(`  Failed to load --repos file "${extraPath}": ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\n  Mach-Speed Auto-Heal v2');
  console.log('  =======================');
  console.log(`  Output directory: ${outputDir}`);
  console.log(`  Test repos: ${testRepos.length}`);

  // Install resilient fetch (auth + retry) — benefits central.js without touching it
  const { token } = installFetchMiddleware();
  if (token) {
    console.log('  GitHub auth: token found (5000 req/hr budget)');
  } else {
    console.log('  GitHub auth: NO TOKEN — unauthenticated limit is 60 req/hr.');
    console.log('  Set GITHUB_TOKEN to avoid rate-limit failures on large test suites.');
  }
  console.log('');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // ── Phase 0: snapshot every test repo once (parallel tarballs). The analyses
  // below then read from disk instead of hammering the API for every file.
  if (process.env[REPO_CACHE_ENV]) {
    console.log('  Phase 0: snapshotting repos (parallel tarballs, one-time per job)...');
    const pre = await prefetchRepos(testRepos, path.resolve(process.env[REPO_CACHE_ENV]), { token });
    const ready = pre.ok.length + pre.cached.length;
    console.log(`  Snapshots: ${ready}/${testRepos.length} ready` +
      (pre.failed.length ? ` — ${pre.failed.length} failed (${pre.failed.map(f => f.slug).join(', ')}), those fetch live` : ''));
    console.log('');
  }

  // ── Phase 1: Run all tests (parallel — snapshots make each repo cheap) ──
  console.log('  Phase 1: Testing specialists against public repos...');
  const allResults = [];
  const repoTypeMap = {};
  const errors = [];

  await pool(testRepos, ANALYSIS_CONCURRENCY, async (repo) => {
    const slug = `${repo.owner}/${repo.repo}`;
    try {
      const result = await withTimeout(analyzeRepo(repo.owner, repo.repo), REPO_TIMEOUT_MS, slug);
      repoTypeMap[slug] = result.repoType;

      for (const check of result.scorecard.checks) {
        allResults.push({
          owner: repo.owner,
          repo: repo.repo,
          expectedType: repo.expected,
          repoType: result.repoType,
          checkId: check.id,
          status: check.status,
          confidence: check.confidence || 'unknown',
          message: check.message || '',
          findings: check.findings || [],
          weight: check.weight || 0,
        });
      }
      console.log(`    ${slug} ... OK (${result.repoType})`);
    } catch (err) {
      errors.push({ repo: slug, error: err.message });
      console.log(`    ${slug} ... ERROR: ${err.message}`);
    }
  });

  // Wait a tick for any async cleanup
  await sleep(100);

  const succeeded = Object.keys(repoTypeMap).length;
  const coverage = testRepos.length ? succeeded / testRepos.length : 0;
  const incomplete = coverage < MIN_REPO_COVERAGE;

  console.log(`\n  Results collected: ${allResults.length} check results`);
  console.log(`  Repos analyzed: ${succeeded}/${testRepos.length} (${(coverage * 100).toFixed(0)}%)`);
  console.log(`  Errors: ${errors.length}`);
  if (incomplete) {
    console.log('\n  ⚠️  INCOMPLETE RUN — too many repos failed to analyze.');
    console.log('  ⚠️  Pattern conclusions below are NOT trustworthy. Fix the errors first');
    console.log('  ⚠️  (most common cause: GitHub rate limit — set GITHUB_TOKEN and re-run).');
  }

  // ── Phase 2: Detect patterns per specialist ──
  console.log('\n  Phase 2: Detecting holistic patterns...');

  const checkIds = [...new Set(allResults.map(r => r.checkId))];
  const specialistReports = [];

  for (const checkId of checkIds) {
    const resultCount = allResults.filter(r => r.checkId === checkId).length;
    const insufficient = resultCount < MIN_SPECIALIST_RESULTS;
    const patterns = insufficient ? [] : detectPatterns(checkId, allResults, repoTypeMap, testRepos);
    const evidence = generateEvidence(checkId, patterns, allResults, repoTypeMap, testRepos);

    const filepath = path.join(outputDir, `${checkId}.md`);
    fs.writeFileSync(filepath, evidence);

    const severityScore = patterns.reduce((sum, p) => {
      const weights = { critical: 4, high: 3, medium: 2, low: 1 };
      return sum + (weights[p.severity] || 1);
    }, 0);

    specialistReports.push({
      checkId,
      patternCount: patterns.length,
      severityScore,
      patterns: patterns.map(p => p.id),
      resultCount,
      insufficientData: insufficient,
      filepath,
    });

    const icon = insufficient ? '??' : patterns.length === 0 ? 'OK' : severityScore >= 8 ? '!!' : severityScore >= 4 ? '!' : 'ok';
    const note = insufficient ? `INSUFFICIENT DATA (${resultCount} results)` : `${patterns.length} pattern(s) (severity: ${severityScore})`;
    console.log(`    [${icon}] ${checkId}: ${note}`);
  }

  // ── Phase 3: Generate master summary ──
  console.log('\n  Phase 3: Generating master summary...');

  const summaryMd = generateMasterSummary(specialistReports, allResults, repoTypeMap, errors, { testRepos, incomplete, coverage, succeeded });
  fs.writeFileSync(path.join(outputDir, 'README.md'), summaryMd);

  // Also generate JSON for programmatic use
  const jsonOutput = {
    generatedAt: new Date().toISOString(),
    version: 2,
    incomplete,
    coverage: Number(coverage.toFixed(3)),
    reposTested: testRepos.length,
    reposSucceeded: succeeded,
    totalCheckResults: allResults.length,
    errors,
    classifierDrift: computeClassifierDrift(repoTypeMap, testRepos),
    specialistReports,
  };
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(jsonOutput, null, 2));

  // Full per-repo-per-check results, one JSON object per line. auto-verify.js uses
  // this as the train-set baseline so it can measure improvement without re-running
  // the whole train sweep.
  fs.writeFileSync(
    path.join(outputDir, 'results.jsonl'),
    allResults.map(r => JSON.stringify(r)).join('\n') + (allResults.length ? '\n' : '')
  );

  // ── Done ──
  console.log('\n  Auto-heal complete!');
  console.log(`  Evidence files written to: ${outputDir}/`);
  console.log(`  - ${checkIds.length} specialist evidence files`);
  console.log(`  - README.md (master summary)`);
  console.log(`  - report.json (machine-readable)`);
  console.log(`  - results.jsonl (raw results, consumed by auto-verify.js)`);
  console.log('');

  if (incomplete) {
    console.log('  ⚠️  RUN WAS INCOMPLETE — do not paste insufficient-data evidence into');
    console.log('  ⚠️  specialist chats. Set GITHUB_TOKEN and re-run for trustworthy results.');
    console.log('');
    return { incomplete, specialistReports, errors };
  }

  // Print priority queue
  const priorityQueue = [...specialistReports]
    .sort((a, b) => b.severityScore - a.severityScore)
    .filter(r => r.severityScore > 0);

  if (priorityQueue.length > 0) {
    console.log('  Priority fix order (highest severity first):');
    for (let i = 0; i < priorityQueue.length; i++) {
      const r = priorityQueue[i];
      console.log(`    ${i + 1}. ${r.checkId} (severity: ${r.severityScore}, patterns: ${r.patternCount})`);
    }
  } else {
    console.log('  All specialists look great! No patterns detected.');
  }
  console.log('');

  return { incomplete, specialistReports, errors };
}

// ── Classifier drift: repos whose actual type differs from expected ──
function computeClassifierDrift(repoTypeMap, testRepos) {
  return testRepos
    .filter(t => repoTypeMap[`${t.owner}/${t.repo}`] && t.expected && t.expected !== 'unknown')
    .map(t => ({
      repo: `${t.owner}/${t.repo}`,
      expected: t.expected,
      actual: repoTypeMap[`${t.owner}/${t.repo}`],
      match: repoTypeMap[`${t.owner}/${t.repo}`] === t.expected,
    }));
}

export function generateMasterSummary(reports, allResults, repoTypeMap, errors, options = {}) {
  const testRepos = options.testRepos || TEST_REPOS;
  const incomplete = options.incomplete ?? false;
  const succeeded = options.succeeded ?? Object.keys(repoTypeMap).length;
  const coverage = options.coverage ?? (testRepos.length ? succeeded / testRepos.length : 0);

  const md = [
    '# Mach-Speed Auto-Heal Report',
    '',
    `**Generated:** ${new Date().toUTCString()}`,
    `**Repos tested:** ${succeeded}/${testRepos.length} succeeded (${(coverage * 100).toFixed(0)}%)`,
    `**Total check results:** ${allResults.length}`,
    `**Errors:** ${errors.length}`,
    '',
  ];

  if (incomplete) {
    md.push('---');
    md.push('');
    md.push('# ⚠️ INCOMPLETE RUN — RESULTS NOT TRUSTWORTHY');
    md.push('');
    md.push(`Only **${succeeded}/${testRepos.length}** repos were analyzed (need ≥${Math.round(MIN_REPO_COVERAGE * 100)}%).`);
    md.push('Pattern detection on this little data produces garbage conclusions — do **not** paste');
    md.push('insufficient-data evidence into specialist chats and do **not** treat "0 patterns" as healthy.');
    md.push('');
    md.push('**Fix:** set a `GITHUB_TOKEN` (unauthenticated limit is only 60 req/hr) and re-run:');
    md.push('```bash');
    md.push('GITHUB_TOKEN=ghp_xxx node auto-heal.js --output ./evidence');
    md.push('```');
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push('## Priority Fix Queue');
  md.push('');
  md.push('| Rank | Specialist | Severity | Patterns | Data | Files |');
  md.push('|------|-----------|----------|----------|------|-------|');

  const priorityQueue = [...reports]
    .sort((a, b) => b.severityScore - a.severityScore)
    .filter(r => r.severityScore > 0 && !r.insufficientData);

  const insufficientReports = reports.filter(r => r.insufficientData);

  if (priorityQueue.length === 0) {
    md.push(incomplete
      ? '| — | Skipped (incomplete run) | — | — | — | — |'
      : '| — | All clear! | — | — | — | — |');
  } else {
    for (let i = 0; i < priorityQueue.length; i++) {
      const r = priorityQueue[i];
      md.push(`| ${i + 1} | ${r.checkId} | ${r.severityScore} | ${r.patternCount} | ${r.resultCount} repos | [${r.checkId}.md](./${r.checkId}.md) |`);
    }
  }
  md.push('');

  if (insufficientReports.length > 0) {
    md.push('## Specialists With Insufficient Data');
    md.push('');
    md.push(`These specialists produced fewer than ${MIN_SPECIALIST_RESULTS} results — no trustworthy conclusions possible:`);
    md.push('');
    for (const r of insufficientReports) {
      md.push(`- **${r.checkId}** (${r.resultCount} results)`);
    }
    md.push('');
  }

  // ── Classifier drift section ──
  const drift = computeClassifierDrift(repoTypeMap, testRepos);
  const mismatches = drift.filter(d => !d.match);
  if (drift.length > 0) {
    md.push('## Classifier Accuracy');
    md.push('');
    md.push(`Classifier matched expected type on **${drift.length - mismatches.length}/${drift.length}** repos.`);
    md.push('Misclassification corrupts every downstream specialist conclusion — fix the classifier first if drift is high.');
    md.push('');
    if (mismatches.length > 0) {
      md.push('| Repo | Expected | Actual |');
      md.push('|------|----------|--------|');
      for (const d of mismatches) {
        md.push(`| ${mdCell(d.repo)} | ${mdCell(d.expected)} | ${mdCell(d.actual)} |`);
      }
      md.push('');
    }
  }

  md.push('## How to Use This Evidence');
  md.push('');
  md.push('1. Open one Kimi chat per specialist that has patterns detected');
  md.push('2. Paste the contents of the specialist\'s `.md` file into the chat');
  md.push('3. Also paste the specialist\'s current `.js` code');
  md.push('4. Ask: "Fix the holistic problems described in the evidence. Make the specialist more decisive and accurate across ALL repo types."');
  md.push('5. Replace the old `.js` file with the improved version');
  md.push('6. Run `node auto-heal.js` again to verify improvement');
  md.push('');
  md.push('## Key Principles');
  md.push('');
  md.push('- **Holistic, not repo-specific:** Evidence describes patterns across all repos');
  md.push('- **Be decisive:** "check-it" should be rare — specialists should make clear pass/fail calls');
  md.push('- **Handle errors visibly:** Log errors, don\'t silently swallow them');
  md.push('- **Support modern tooling:** Recognize pnpm, Vite, Turborepo, Drizzle, etc.');
  md.push('- **Work across all repo types:** Library, deployable, server, framework, tool');
  md.push('');

  if (errors.length > 0) {
    md.push('## Errors During Testing');
    md.push('');
    for (const e of errors) {
      md.push(`- **${mdCell(e.repo)}:** ${mdCell(e.error)}`);
    }
    md.push('');
  }

  md.push('---');
  md.push('*Generated by auto-heal.js v2*');

  return md.join('\n');
}

// ── Run only when executed directly (importing this module has no side effects) ──
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  autoheal().catch(err => {
    console.error('\n  Fatal error:', err);
    process.exit(1);
  });
}
