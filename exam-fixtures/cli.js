#!/usr/bin/env node
/**
 * exam-fixtures/cli.js — local validation tool for the fixture module.
 *
 *   node exam-fixtures/cli.js build <cacheDir>
 *     Build all fixture snapshots into <cacheDir> and print a manifest summary.
 *
 *   node exam-fixtures/cli.js run <repoRoot> <cacheDir>
 *     Build, then analyze every fixture IN-PROCESS with analyzeRepo from
 *     <repoRoot>/central.js — fully offline. Sets MACH_SPEED_REPO_CACHE and
 *     calls installFetchMiddleware (from <repoRoot>/auto-heal.js) BEFORE
 *     importing central.js, so all fetches are served from disk.
 *     Prints, per fixture: expected vs actual repoType and a per-expectation
 *     PASS/MISS table; then a final per-checkId mutant/positive summary.
 *
 * Importing this file runs nothing — the CLI only executes when run directly.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildFixtures } from './build.js';
import { evaluateFixtureRows } from './evaluate.js';

const STATUS_MARK = { pass: 'ok', 'not-applicable': 'n/a', fail: 'FLAG', 'check-it': 'flag' };

function usage() {
  console.log('Usage:');
  console.log('  node exam-fixtures/cli.js build <cacheDir>');
  console.log('  node exam-fixtures/cli.js run <repoRoot> <cacheDir>');
}

function printManifestSummary(manifest, cacheDir) {
  console.log(`Built ${manifest.length} fixture snapshot(s) into ${cacheDir}:`);
  for (const m of manifest) {
    const checks = Object.keys(m.expect).join(', ');
    console.log(`  [${m.kind}] ${m.slug} (type: ${m.expectedType}) — expectations: ${checks}`);
  }
}

async function cmdBuild(cacheDir) {
  const manifest = await buildFixtures(cacheDir);
  printManifestSummary(manifest, path.resolve(cacheDir));
}

async function cmdRun(repoRootArg, cacheDirArg) {
  const repoRoot = path.resolve(repoRootArg);
  const cacheDir = path.resolve(cacheDirArg);

  const manifest = await buildFixtures(cacheDir);
  printManifestSummary(manifest, cacheDir);
  console.log('');

  // CRITICAL ORDER: env + fetch middleware BEFORE central.js is imported, so
  // every fetch central.js makes is served from the disk snapshots (offline).
  process.env.MACH_SPEED_REPO_CACHE = cacheDir;
  const { installFetchMiddleware } = await import(pathToFileURL(path.join(repoRoot, 'auto-heal.js')).href);
  installFetchMiddleware({ verbose: false });
  const { analyzeRepo } = await import(pathToFileURL(path.join(repoRoot, 'central.js')).href);

  const rows = [];
  const errors = [];
  for (const entry of manifest) {
    console.log('─'.repeat(76));
    let res;
    try {
      res = await analyzeRepo(entry.owner, entry.repo);
    } catch (err) {
      errors.push({ slug: entry.slug, error: String((err && err.message) || err) });
      console.log(`${entry.slug}  [${entry.kind}]`);
      console.log(`  ANALYSIS CRASHED: ${err.message}`);
      continue;
    }

    const typeMark = res.repoType === entry.expectedType ? 'MATCH' : 'DRIFT';
    console.log(`${entry.slug}  [${entry.kind}]`);
    console.log(`  repoType: expected ${entry.expectedType} | actual ${res.repoType}  (${typeMark})`);
    console.log(`  note: ${entry.note}`);

    const byCheck = new Map((res.results || []).map((r) => [r.checkId, r]));
    for (const [checkId, allowed] of Object.entries(entry.expect)) {
      const row = byCheck.get(checkId);
      // Missing row = specialist never ran on this repoType = not-applicable.
      const status = row ? row.status : 'not-applicable';
      const hit = allowed.includes(status);
      const label = entry.kind === 'mutant' ? (hit ? 'CAUGHT' : 'MISS') : (hit ? 'GREEN' : 'LOST');
      console.log(`  ${label.padEnd(6)} ${checkId.padEnd(16)} status=${status} (${STATUS_MARK[status] || '?'}) allowed=[${allowed.join(', ')}]`);
    }

    for (const r of res.results || []) {
      rows.push({
        owner: entry.owner,
        repo: entry.repo,
        expectedType: entry.expectedType,
        repoType: res.repoType,
        checkId: r.checkId,
        status: r.status,
        confidence: r.confidence,
        message: r.message,
      });
    }
  }

  console.log('─'.repeat(76));
  console.log('\nPer-checkId summary (mutants caught / positives green):');
  const map = evaluateFixtureRows(rows, manifest);
  for (const [checkId, b] of map) {
    const parts = [];
    if (b.mutantsTotal > 0) parts.push(`mutants ${b.mutantsCaught}/${b.mutantsTotal} caught`);
    if (b.positivesTotal > 0) parts.push(`positives ${b.positivesGreen}/${b.positivesTotal} green`);
    console.log(`  ${checkId.padEnd(16)} ${parts.join(' | ')}`);
    for (const m of b.mutantsMissed) console.log(`      MISSED mutant: ${m.slug} (status: ${m.status})`);
    for (const p of b.positivesLost) console.log(`      LOST positive: ${p.slug} (status: ${p.status})`);
  }
  if (errors.length > 0) {
    console.log(`\n${errors.length} fixture(s) failed to analyze:`);
    for (const e of errors) console.log(`  ${e.slug}: ${e.error}`);
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'build' && rest.length === 1) return cmdBuild(rest[0]);
  if (cmd === 'run' && rest.length === 2) return cmdRun(rest[0], rest[1]);
  usage();
  process.exitCode = 1;
}

// CLI only when executed directly — importing this file has no side effects.
const invokedAs = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedAs) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}
