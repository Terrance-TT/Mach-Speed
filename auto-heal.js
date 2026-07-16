#!/usr/bin/env node
// auto-heal.js — Test specialists against public repos, detect holistic patterns, generate evidence
// Usage: node auto-heal.js [--output ./evidence] [--repos extra-repos.json]
//
// This script tests the Mach-Speed specialist suite against a diverse set of public repos,
// then generates HOLISTIC evidence per specialist — identifying systematic patterns, not
// repo-specific bugs. The evidence is designed to be pasted directly into Kimi chats for
// specialist improvement.

import { RepoType } from './contract.js';
import { analyzeRepo } from './central.js';
import { SPECIALIST_REGISTRY } from './contract.js';
import fs from 'fs';
import path from 'path';

// ── Expanded test suite — diverse repo types for holistic testing ──
const TEST_REPOS = [
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
  { owner: 'expressjs',     repo: 'express',         expected: 'framework',   tags: ['server', 'framework', ' minimalist'] },
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
const HOLISTIC_PATTERNS = {
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
    threshold: 0.30, // >30% variance in pass rate between repo types
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
const SPECIALIST_GROUND_TRUTH = {
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
    positiveSignals: ['/health route', '/status endpoint', 'healthcheck middleware', ' readiness probe', 'liveness probe'],
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

// ── Pattern detection engine ──
function detectPatterns(checkId, results, repoTypeMap) {
  const patterns = [];
  const specialistResults = results.filter(r => r.checkId === checkId);

  if (specialistResults.length === 0) return patterns;

  const statuses = specialistResults.map(r => r.status);
  const total = statuses.length;
  const checkItCount = statuses.filter(s => s === 'check-it').length;
  const failCount = statuses.filter(s => s === 'fail').length;
  const passCount = statuses.filter(s => s === 'pass').length;
  const naCount = statuses.filter(s => s === 'not-applicable').length;
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
  const byType = {};
  for (const r of specialistResults) {
    if (!byType[r.repoType]) byType[r.repoType] = { pass: 0, total: 0 };
    byType[r.repoType].total++;
    if (r.status === 'pass') byType[r.repoType].pass++;
  }
  const passRates = Object.values(byType).map(v => v.pass / v.total);
  if (passRates.length > 1) {
    const maxRate = Math.max(...passRates);
    const minRate = Math.min(...passRates);
    if (maxRate - minRate > HOLISTIC_PATTERNS.REPO_TYPE_BIAS.threshold) {
      const typeDetails = Object.entries(byType)
        .map(([type, v]) => `${type}: ${v.pass}/${v.total} pass`)
        .join(', ');
      patterns.push({
        ...HOLISTIC_PATTERNS.REPO_TYPE_BIAS,
        evidence: `Pass rate varies significantly by repo type: ${typeDetails}. Range: ${(minRate * 100).toFixed(0)}% - ${(maxRate * 100).toFixed(0)}%`,
        frequency: maxRate - minRate,
      });
    }
  }

  // Pattern 6: Missed signal (check-it when ground truth says it should find something)
  const groundTruth = SPECIALIST_GROUND_TRUTH[checkId];
  if (groundTruth) {
    const missed = specialistResults.filter(r => {
      const repo = TEST_REPOS.find(t => t.owner === r.owner && t.repo === r.repo);
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
      const repo = TEST_REPOS.find(t => t.owner === r.owner && t.repo === r.repo);
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
function generateEvidence(checkId, patterns, allResults, repoTypeMap) {
  const specialistResults = allResults.filter(r => r.checkId === checkId);
  const groundTruth = SPECIALIST_GROUND_TRUTH[checkId];
  const registryEntry = SPECIALIST_REGISTRY[checkId];

  const total = specialistResults.length;
  const statuses = {
    pass: specialistResults.filter(r => r.status === 'pass').length,
    fail: specialistResults.filter(r => r.status === 'fail').length,
    'check-it': specialistResults.filter(r => r.status === 'check-it').length,
    'not-applicable': specialistResults.filter(r => r.status === 'not-applicable').length,
  };

  // Build per-repo detail table
  const repoDetails = specialistResults.map(r => {
    const repo = TEST_REPOS.find(t => t.owner === r.owner && t.repo === r.repo);
    const shouldRun = registryEntry?.includes('all') || registryEntry?.includes(r.repoType);
    return {
      repo: `${r.owner}/${r.repo}`,
      type: r.repoType,
      expected: repo?.expected || '?',
      status: r.status,
      confidence: r.confidence,
      findings: r.findings?.length || 0,
      shouldRun: shouldRun ? 'yes' : 'NO',
      message: r.message?.substring(0, 80) || '',
    };
  });

  // Sort by status (fails first, then check-its)
  repoDetails.sort((a, b) => {
    const order = { fail: 0, 'check-it': 1, pass: 2, 'not-applicable': 3 };
    return (order[a.status] || 9) - (order[b.status] || 9);
  });

  const md = [`# Evidence for \`${checkId}\` Specialist`, ''];

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

  if (patterns.length > 0) {
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
    md.push(`This specialist is performing well across the test suite. No systematic patterns of failure were found.`);
    md.push('');
  }

  md.push(`## Per-Repo Results`);
  md.push('');
  md.push(`| Repo | Type | Status | Confidence | Findings | Should Run | Message |`);
  md.push(`|------|------|--------|------------|----------|------------|---------|`);
  for (const d of repoDetails) {
    const icon = d.status === 'pass' ? 'PASS' : d.status === 'fail' ? 'FAIL' : d.status === 'check-it' ? 'CHECK' : 'N/A';
    md.push(`| ${d.repo} | ${d.type} | ${icon} ${d.status} | ${d.confidence} | ${d.findings} | ${d.shouldRun} | ${d.message} |`);
  }
  md.push('');

  md.push(`---`);
  md.push(`*Generated by auto-heal.js — Mach-Speed diagnostic tool*`);
  md.push(`*This evidence is HOLISTIC: it describes patterns across ALL repos, not fixes for specific ones.*`);

  return md.join('\n');
}

// ── Main execution ──
async function autoheal() {
  const args = process.argv.slice(2);
  const outputDir = args.includes('--output') ? args[args.indexOf('--output') + 1] : './evidence';

  console.log('\n  Mach-Speed Auto-Heal');
  console.log('  ======================');
  console.log(`  Output directory: ${outputDir}`);
  console.log(`  Test repos: ${TEST_REPOS.length}`);
  console.log('');

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // ── Phase 1: Run all tests ──
  console.log('  Phase 1: Testing specialists against public repos...');
  const allResults = [];
  const repoTypeMap = {};
  const errors = [];

  for (const repo of TEST_REPOS) {
    try {
      process.stdout.write(`    ${repo.owner}/${repo.repo} ... `);
      const result = await analyzeRepo(repo.owner, repo.repo);
      repoTypeMap[`${repo.owner}/${repo.repo}`] = result.repoType;

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
      console.log(`OK (${result.repoType})`);
    } catch (err) {
      errors.push({ repo: `${repo.owner}/${repo.repo}`, error: err.message });
      console.log(`ERROR: ${err.message}`);
    }
  }

  // Wait a tick for any async cleanup
  await new Promise(r => setTimeout(r, 100));

  console.log(`\n  Results collected: ${allResults.length} check results`);
  console.log(`  Errors: ${errors.length}`);

  // ── Phase 2: Detect patterns per specialist ──
  console.log('\n  Phase 2: Detecting holistic patterns...');

  const checkIds = [...new Set(allResults.map(r => r.checkId))];
  const specialistReports = [];

  for (const checkId of checkIds) {
    const patterns = detectPatterns(checkId, allResults, repoTypeMap);
    const evidence = generateEvidence(checkId, patterns, allResults, repoTypeMap);

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
      filepath,
    });

    const icon = patterns.length === 0 ? 'OK' : severityScore >= 8 ? '!!' : severityScore >= 4 ? '!' : 'ok';
    console.log(`    [${icon}] ${checkId}: ${patterns.length} pattern(s) (severity: ${severityScore})`);
  }

  // ── Phase 3: Generate master summary ──
  console.log('\n  Phase 3: Generating master summary...');

  const summaryMd = generateMasterSummary(specialistReports, allResults, repoTypeMap, errors);
  fs.writeFileSync(path.join(outputDir, 'README.md'), summaryMd);

  // Also generate JSON for programmatic use
  const jsonOutput = {
    generatedAt: new Date().toISOString(),
    reposTested: TEST_REPOS.length,
    totalCheckResults: allResults.length,
    errors,
    specialistReports,
  };
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(jsonOutput, null, 2));

  // ── Done ──
  console.log('\n  Auto-heal complete!');
  console.log(`  Evidence files written to: ${outputDir}/`);
  console.log(`  - ${checkIds.length} specialist evidence files`);
  console.log(`  - README.md (master summary)`);
  console.log(`  - report.json (machine-readable)`);
  console.log('');

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
}

function generateMasterSummary(reports, allResults, repoTypeMap, errors) {
  const md = [
    '# Mach-Speed Auto-Heal Report',
    '',
    `**Generated:** ${new Date().toUTCString()}`,
    `**Repos tested:** ${TEST_REPOS.length}`,
    `**Total check results:** ${allResults.length}`,
    `**Errors:** ${errors.length}`,
    '',
    '---',
    '',
    '## Priority Fix Queue',
    '',
    '| Rank | Specialist | Severity | Patterns | Files |',
    '|------|-----------|----------|----------|-------|',
  ];

  const priorityQueue = [...reports]
    .sort((a, b) => b.severityScore - a.severityScore)
    .filter(r => r.severityScore > 0);

  if (priorityQueue.length === 0) {
    md.push('| — | All clear! | — | — | — |');
  } else {
    for (let i = 0; i < priorityQueue.length; i++) {
      const r = priorityQueue[i];
      md.push(`| ${i + 1} | ${r.checkId} | ${r.severityScore} | ${r.patternCount} | [${r.checkId}.md](./${r.checkId}.md) |`);
    }
  }

  md.push('');
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
      md.push(`- **${e.repo}:** ${e.error}`);
    }
    md.push('');
  }

  md.push('---');
  md.push('*Generated by auto-heal.js*');

  return md.join('\n');
}

// Run
autoheal().catch(err => {
  console.error('\n  Fatal error:', err);
  process.exit(1);
});
