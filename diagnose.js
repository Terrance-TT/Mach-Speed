#!/usr/bin/env node
// diagnose.js — Run specialists against known repos and report exact failures
// Usage: node diagnose.js
//
// Works in two modes:
//   1. Classifier-only: if specialists/ folder is empty (no .js files besides _template.js)
//   2. Full audit: if specialist .js files exist and are wired in central.js

import { RepoType } from './contract.js';

// ── Known repos with their expected repo type ──
const TEST_REPOS = [
  { owner: 'facebook',    repo: 'react',        expected: 'library',    note: 'UI library with peerDependencies' },
  { owner: 'expressjs',   repo: 'express',      expected: 'framework',  note: 'Server framework' },
  { owner: 'nodejs',      repo: 'nodejs.org',   expected: 'deployable', note: 'Next.js website' },
  { owner: 'withastro',   repo: 'astro',        expected: 'deployable', note: 'Astro site' },
  { owner: 'calcom',      repo: 'cal.com',      expected: 'deployable', note: 'Next.js app' },
  { owner: 'vercel',      repo: 'next.js',      expected: 'framework',  note: 'Meta-framework (Next.js itself)' },
  { owner: 'nuxt',        repo: 'nuxt',         expected: 'framework',  note: 'Meta-framework (Nuxt itself)' },
  { owner: 'supabase',    repo: 'supabase',     expected: 'framework',  note: 'Platform/framework' },
];

// ── Fetch helpers (copied here so classifier can be tested without central.js loading) ──
async function fetchRepoTree(owner, repo) {
  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (!metaRes.ok) throw new Error(`GitHub API error: ${metaRes.status}`);
  const meta = await metaRes.json();
  const branch = meta.default_branch;
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  );
  if (!treeRes.ok) throw new Error(`Tree API error: ${treeRes.status}`);
  const treeData = await treeRes.json();
  return {
    branch,
    tree: treeData.tree.map(item => item.path),
    sha: treeData.sha,
  };
}

async function fetchFile(owner, repo, branch, path) {
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
  );
  if (!res.ok) return null;
  return res.text();
}

// ── Score what a good specialist result looks like ──
function scoreResult(result, repoHasPackageJson) {
  const issues = [];
  if (result.status === 'check-it') issues.push('returns check-it (too cautious)');
  if (result.status === 'not-applicable' && result.findings?.length > 0) {
    issues.push('not-applicable but has findings (contradictory)');
  }
  if (result.message?.includes('No package.json') && repoHasPackageJson) {
    issues.push('says "No package.json" but repo HAS one');
  }
  if (result.confidence === 'high' && result.status === 'check-it') {
    issues.push('high confidence + check-it (inconsistent)');
  }
  return issues;
}

// ── Main ──
async function diagnose() {
  console.log('\n  Mach-Speed Diagnostic Tool\n  ==========================\n');

  // ── Phase 1: Classifier check ──
  console.log('  CLASSIFIER TESTS');
  console.log('  ────────────────');
  const failures = [];

  for (const r of TEST_REPOS) {
    try {
      const { tree, branch } = await fetchRepoTree(r.owner, r.repo);
      let packageJson = null;
      const pkg = await fetchFile(r.owner, r.repo, branch, 'package.json');
      if (pkg) try { packageJson = JSON.parse(pkg); } catch { }

      const { classifyRepo, classifyRepoDebug } = await import('./classifier.js');
      const result = await classifyRepo(tree, packageJson);
      const pass = result === r.expected;
      if (!pass) failures.push(`${r.owner}/${r.repo}: got "${result}", expected "${r.expected}"`);

      const icon = pass ? '✅' : '❌';
      console.log(`  ${icon} ${r.owner}/${r.repo} → ${result} (expected: ${r.expected})`);
      if (!pass) {
        console.log(`     ${r.note}`);
        // Print debug scores
        try {
          const debug = await classifyRepoDebug(tree, packageJson);
          console.log(`     Scores: ${JSON.stringify(debug.scores)}`);
          console.log(`     Signals: ${JSON.stringify(debug.signals)}`);
        } catch { /* ignore debug errors */ }
      }
    } catch (err) {
      failures.push(`${r.owner}/${r.repo}: ERROR - ${err.message}`);
      console.log(`  ❌ ${r.owner}/${r.repo} → ERROR: ${err.message}`);
    }
  }

  // ── Phase 2: Check if specialists exist ──
  console.log('\n\n  SPECIALIST CHECK');
  console.log('  ────────────────');

  let hasSpecialists = false;
  let analyzeRepo = null;

  try {
    const central = await import('./central.js');
    hasSpecialists = central.SPECIALISTS && central.SPECIALISTS.length > 0;
    analyzeRepo = central.analyzeRepo;

    if (hasSpecialists) {
      console.log(`  ✅ ${central.SPECIALISTS.length} specialist(s) registered`);
      for (const s of central.SPECIALISTS) {
        const name = s.checkId || s.name || 'unknown';
        console.log(`     • ${name}`);
      }
    } else {
      console.log('  ⚠️  central.js loaded but SPECIALISTS array is empty');
      console.log('     Add imports + array entries to activate specialist audit');
    }
  } catch (err) {
    console.log('  ⚠️  Could not load central.js (specialist files probably missing)');
    console.log(`     Error: ${err.message.split('\n')[0]}`);
    console.log('\n  To fix: copy your specialist .js files into specialists/ folder');
  }

  // ── Phase 3: Full specialist audit (only if specialists exist) ──
  if (hasSpecialists && analyzeRepo) {
    console.log('\n\n  SPECIALIST AUDIT');
    console.log('  ────────────────');

    for (const r of TEST_REPOS) {
      try {
        const result = await analyzeRepo(r.owner, r.repo);
        const sc = result.scorecard;
        const checkIts = sc.checks.filter(c => c.status === 'check-it').length;
        const fails = sc.checks.filter(c => c.status === 'fail').length;

        console.log(`\n  ${r.owner}/${r.repo} (${sc.repoType}) score:${sc.score}/10`);
        console.log(`     check-it:${checkIts}  fail:${fails}  pass:${sc.summary.passed}`);

        if (checkIts >= 6) {
          console.log(`     ⚠️  Too many check-it results — specialists too cautious`);
        }

        for (const check of sc.checks) {
          const repoHasPkg = result.packageJson !== null;
          const issues = scoreResult(check, repoHasPkg);
          if (issues.length > 0) {
            console.log(`     ❌ ${check.id}: ${issues.join('; ')}`);
          }
        }
      } catch (err) {
        console.log(`\n  ❌ ${r.owner}/${r.repo} → ERROR: ${err.message}`);
      }
    }
  }

  // ── Summary ──
  console.log('\n\n  SUMMARY');
  console.log('  ───────');
  console.log(`  Classifier: ${failures.length} misclassification(s) / ${TEST_REPOS.length} repos`);
  if (failures.length > 0) {
    console.log('\n  Failed:');
    for (const f of failures) console.log(`    ❌ ${f}`);
  } else {
    console.log('  ✅ Classifier looks good!');
  }

  if (!hasSpecialists) {
    console.log('\n  Specialists: not tested (none registered)');
    console.log('  Copy your .js files to specialists/ and re-run');
  }
  console.log();
}

diagnose().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
