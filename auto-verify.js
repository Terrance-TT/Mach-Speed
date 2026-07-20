#!/usr/bin/env node
// auto-verify.js — the verify-then-merge gate for Mach-Speed self-healing.
//
// Usage:
//   node auto-verify.js --evidence ./evidence --proposed ./proposed [--pr] [--dry-run]
//                       [--rounds 2] [--only cors,dynamic-port] [--repo owner/name]
//                       [--holdout holdout-repos.json]
//
// What it does:
//   auto-fix.js writes PROPOSED specialist rewrites to ./proposed (never merged blind).
//   This script is the GATE that replaces human code review with measurement:
//
//   1. ANTI-GAMING LINT — rejects rewrites that hardcode test-repo names/owners or
//      compare context.owner/context.repo against string literals. Scoring hacks
//      never even reach the test phase.
//   2. TRAIN/TEST SPLIT — measures every candidate on 15 train repos (the ones the
//      AI saw in evidence) AND on 8 HIDDEN holdout repos the AI has never seen.
//      A fix that only memorizes the evidence repos gets caught here.
//   3. MERGE RULES (all must hold):
//        a. strictly better on the train set (pattern severity drops, or check-it
//           rate drops >=5 points while average score rises)
//        b. no damage on the hidden set (severity must not increase)
//        c. zero regression flips (no repo goes pass -> check-it/fail, check-it -> fail)
//        d. zero new crashes ("Specialist crashed/error" messages)
//        e. no NEW pattern ids on either set
//        f. clean anti-gaming lint
//   4. FEEDBACK LOOP — losers go BACK to Moonshot (same per-specialist thread) with
//      the measured failures attached; the next version is re-tested (up to --rounds).
//   5. VERIFY-THEN-MERGE — winners are squash-merged to main IN THE SAME JOB (a PR is
//      opened for the audit trail, commented with the scoreboard, then merged).
//      Only winners whose merge ACTUALLY succeeded are reported as "merged" — a
//      failed merge demotes the winner to the loser list with the error attached.
//      Merges by GITHUB_TOKEN do not re-trigger workflows, which is exactly why
//      verification happens HERE, pre-merge, instead of in a follow-up workflow.
//   6. UNDO — before the first merge, tag `pre-autofix-<timestamp>` is placed on main;
//      every squash merge can also be reverted from the GitHub UI.
//
// Env:
//   GITHUB_TOKEN       (required for --pr; also raises API rate limits for testing)
//   GITHUB_REPOSITORY  owner/repo (Actions provides it; or use --repo)
//   MOONSHOT_API_KEY   (required for the feedback retry loop; without it, losers are
//                       simply reported and nothing is merged that did not pass)

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { installFetchMiddleware, detectPatterns, TEST_REPOS } from './auto-heal.js';
import { prefetchRepos, pool, REPO_CACHE_ENV } from './repo-cache.js';
import { buildFixtures, fixtureSlugs, FIXTURE_OWNER } from './exam-fixtures/build.js';
import { FIXTURES } from './exam-fixtures/specs.js';
import { resolveExamSeed, generateFixtures, EXAM_SEED_PATH } from './exam-fixtures/generate.js';
import { evaluateFixtureRows, fixtureVerdict } from './exam-fixtures/evaluate.js';
import {
  Moonshot, ThreadStore, GitHubApi, SYSTEM_PROMPT, STATE_BRANCH,
  extractModule, validateModuleSource, validateModuleRuntime,
  buildSpecialistFileMap, specialistFileFor,
} from './auto-fix.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tuning knobs ──
const REPO_TIMEOUT_MS = 240_000;         // per-repo analysis cap (matches auto-heal)
const CHILD_TIMEOUT_MS = REPO_TIMEOUT_MS + 30_000;
const SWEEP_CONCURRENCY = 6;             // repo analyses in parallel (snapshots make this cheap)
const FEEDBACK_CONCURRENCY = 3;          // parallel Moonshot feedback calls (429-handler paces them)
const CALL_SPACING_MS = 1_500;
const MAX_CANDIDATES = 8;                // bound nightly cost
const MAX_ROUNDS = 3;                    // hard cap on test rounds regardless of --rounds
const CHECKIT_IMPROVEMENT_MARGIN = 0.05; // secondary "improved" signal (5 points)
const RUNNER_FILE = '.auto-verify-runner.mjs';

// ── Hidden holdout set — NEVER appears in evidence, so the AI cannot tune for it ──
export const HOLDOUT_REPOS = [
  { owner: 'axios',       repo: 'axios',      expected: 'library',    tags: ['library', 'http-client'] },
  { owner: 'date-fns',    repo: 'date-fns',   expected: 'library',    tags: ['library', 'utility'] },
  { owner: 'nestjs',      repo: 'nest',       expected: 'framework',  tags: ['server', 'framework', 'monorepo'] },
  { owner: 'strapi',      repo: 'strapi',     expected: 'deployable', tags: ['server', 'cms', 'monorepo'] },
  { owner: 'TryGhost',    repo: 'Ghost',      expected: 'deployable', tags: ['server', 'cms', 'monorepo', 'complex'] },
  { owner: 'remix-run',   repo: 'remix',      expected: 'framework',  tags: ['framework', 'meta-framework', 'monorepo'] },
  { owner: 'vitejs',      repo: 'vite',       expected: 'tool',       tags: ['tool', 'bundler', 'monorepo'] },
  { owner: 'prettier',    repo: 'prettier',   expected: 'tool',       tags: ['tool', 'cli', 'formatter'] },
];

// ── Anti-gaming lint ──
// Full owner/repo slugs of every repo used anywhere in the pipeline. A legit specialist
// NEVER needs to name a specific repo — naming one is a scoring hack by definition.
const ALL_TEST_SLUGS = [
  ...TEST_REPOS.map(r => `${r.owner}/${r.repo}`.toLowerCase()),
  ...HOLDOUT_REPOS.map(r => `${r.owner}/${r.repo}`.toLowerCase()),
  ...fixtureSlugs().map(s => s.toLowerCase()),
];
// Distinctive owner/org names. Deliberately EXCLUDES names that are also legit tech
// terms a specialist may reference (vercel->vercel.json, nodejs, nuxt, astro, webpack,
// supabase, fastify, nestjs, strapi, axios, prettier, react as package names).
const BANNED_OWNER_TOKENS = [
  'facebook', 'calcom', 'withastro', 'expressjs', 'sveltejs', 'lodash',
  'microsoft', 'tryghost', 'date-fns', 'remix-run', 'vitejs', FIXTURE_OWNER,
];

export function antiGameLint(checkId, code) {
  const hits = [];
  const lower = code.toLowerCase();
  for (const slug of ALL_TEST_SLUGS) {
    if (lower.includes(slug)) hits.push(`hardcodes test-repo slug '${slug}'`);
  }
  for (const token of BANNED_OWNER_TOKENS) {
    if (lower.includes(token)) hits.push(`references test-org name '${token}'`);
  }
  // Comparing the context owner/repo against a string literal = repo-specific hack.
  if (/\bowner\s*={2,3}\s*['"`]/.test(code)) hits.push("compares context owner against a string literal");
  if (/\brepo\s*={2,3}\s*['"`]/.test(code)) hits.push("compares context repo against a string literal");
  return hits;
}

// ── CLI parsing ──
function parseArgs(argv) {
  const opt = {
    evidence: './evidence', proposed: './proposed', pr: false, dryRun: false,
    rounds: 2, only: null, repo: null, holdout: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--evidence') opt.evidence = argv[++i];
    else if (a === '--proposed') opt.proposed = argv[++i];
    else if (a === '--pr') opt.pr = true;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--rounds') opt.rounds = Math.min(Math.max(1, Number(argv[++i]) || 1), MAX_ROUNDS);
    else if (a === '--only') opt.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--repo') opt.repo = argv[++i];
    else if (a === '--holdout') opt.holdout = argv[++i];
  }
  return opt;
}

// ── Child-process runner ──
// Each repo analysis runs in a FRESH node process. Two reasons:
//   1. ESM module cache: central.js statically imports the specialist modules, so a
//      rewritten specialist file is only picked up by a new process.
//   2. Isolation: one hanging/crashing repo can never poison the verifier itself.
// The runner installs the same fetch middleware (auth + retry) as auto-heal.
const RUNNER_SOURCE = [
  "import { installFetchMiddleware } from './auto-heal.js';",
  "import { analyzeRepo } from './central.js';",
  '',
  'installFetchMiddleware({ verbose: false });',
  'const [owner, repo] = process.argv.slice(2);',
  'try {',
  '  const r = await analyzeRepo(owner, repo);',
  '  process.stdout.write(JSON.stringify({ ok: true, repoType: r.repoType, checks: r.scorecard.checks }));',
  '} catch (err) {',
  '  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));',
  '}',
  '',
].join('\n');

function ensureRunner(repoRoot) {
  const p = path.join(repoRoot, RUNNER_FILE);
  fs.writeFileSync(p, RUNNER_SOURCE);
  return p;
}

function cleanupRunner(repoRoot) {
  try { fs.unlinkSync(path.join(repoRoot, RUNNER_FILE)); } catch { /* best effort */ }
}

// Promisified execFile that never throws — the outcome rides back in `error`,
// exactly like the old execFileSync try/catch contract (killed/SIGTERM = timeout).
const execFileP = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, opts, (error, stdout, stderr) => resolve({ error, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() }));
});

function parseRunnerOutput(out) {
  const start = out.indexOf('{');
  if (start === -1) return { ok: false, error: `no JSON from runner (output: ${out.slice(0, 120)})` };
  try {
    return JSON.parse(out.slice(start));
  } catch (err) {
    return { ok: false, error: `bad JSON from runner: ${err.message}` };
  }
}

async function runRepoAnalysis(repoRoot, runnerPath, owner, repo) {
  const { error, stdout } = await execFileP(process.execPath, [runnerPath, owner, repo], {
    cwd: repoRoot,
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env, // GITHUB_TOKEN (+ repo snapshot cache) flows through to the fetch middleware
  });
  if (!error) return parseRunnerOutput(stdout);
  const msg = error.killed || (error.signal === 'SIGTERM')
    ? `timed out after ${Math.round(CHILD_TIMEOUT_MS / 1000)}s`
    : String(error.message || error).slice(0, 200);
  return { ok: false, error: msg };
}

// Run a set of repos (in parallel), return rows in the same shape auto-heal produces.
async function runSweep(repoRoot, runnerPath, repos, label) {
  const rows = [];
  const repoTypeMap = {};
  const errors = [];
  await pool(repos, SWEEP_CONCURRENCY, async (r) => {
    const slug = `${r.owner}/${r.repo}`;
    const res = await runRepoAnalysis(repoRoot, runnerPath, r.owner, r.repo);
    if (!res.ok) {
      errors.push({ repo: slug, error: res.error });
      console.log(`      [${label}] ${slug} ... ERROR: ${res.error}`);
      return;
    }
    repoTypeMap[slug] = res.repoType;
    for (const c of res.checks || []) {
      rows.push({
        owner: r.owner,
        repo: r.repo,
        expectedType: r.expected,
        repoType: res.repoType,
        checkId: c.id || c.checkId,
        status: c.status,
        confidence: c.confidence || 'unknown',
        message: c.message || '',
        findings: c.findings || [],
        weight: c.weight || 0,
      });
    }
    console.log(`      [${label}] ${slug} ... OK (${res.repoType})`);
  });
  return { rows, repoTypeMap, errors };
}

// Train baseline: prefer the results.jsonl auto-heal wrote this same run (free);
// fall back to re-running the train sweep when the file is missing.
async function loadTrainBaseline(evidenceDir, repoRoot, runnerPath) {
  const jsonlPath = path.join(evidenceDir, 'results.jsonl');
  if (fs.existsSync(jsonlPath)) {
    const rows = fs.readFileSync(jsonlPath, 'utf8')
      .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    const repoTypeMap = {};
    for (const r of rows) repoTypeMap[`${r.owner}/${r.repo}`] = r.repoType;
    console.log(`    Train baseline: loaded ${rows.length} rows from results.jsonl (no re-run needed)`);
    return { rows, repoTypeMap, errors: [] };
  }
  console.log('    Train baseline: results.jsonl missing — re-running train sweep');
  return runSweep(repoRoot, runnerPath, TEST_REPOS, 'train-baseline');
}

// ── Metrics ──
const STATUS_SCORE = { pass: 1, 'check-it': 0.5, fail: 0 };
const scoreOf = (status) => (status in STATUS_SCORE ? STATUS_SCORE[status] : null); // not-applicable -> null

export function severityOf(patterns) {
  const weights = { critical: 4, high: 3, medium: 2, low: 1 };
  return patterns.reduce((sum, p) => sum + (weights[p.severity] || 1), 0);
}

export function computeMetrics(checkId, rows, repoTypeMap, repos) {
  const sub = rows.filter(r => r.checkId === checkId);
  const patterns = detectPatterns(checkId, rows, repoTypeMap, repos);
  const scores = sub.map(r => scoreOf(r.status)).filter(s => s !== null);
  return {
    resultCount: sub.length,
    severity: severityOf(patterns),
    patternIds: patterns.map(p => p.id),
    checkItRate: sub.length ? sub.filter(r => r.status === 'check-it').length / sub.length : null,
    avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  };
}

// Any repo whose numeric score DROPPED after the fix (pass->check-it/fail, check-it->fail).
export function regressionFlips(beforeRows, afterRows, checkId) {
  const before = new Map();
  for (const r of beforeRows) if (r.checkId === checkId) before.set(`${r.owner}/${r.repo}`, r.status);
  const flips = [];
  for (const r of afterRows) {
    if (r.checkId !== checkId) continue;
    const key = `${r.owner}/${r.repo}`;
    if (!before.has(key)) continue;
    const s0 = scoreOf(before.get(key));
    const s1 = scoreOf(r.status);
    if (s0 !== null && s1 !== null && s1 < s0) {
      flips.push({ repo: key, from: before.get(key), to: r.status });
    }
  }
  return flips;
}

const isCrash = (msg) => /^Specialist (crashed|error):/.test(msg || '');

// Crashes/errors that appeared AFTER the fix on repos where there were none before.
export function newCrashes(beforeRows, afterRows, checkId) {
  const before = new Map();
  for (const r of beforeRows) if (r.checkId === checkId) before.set(`${r.owner}/${r.repo}`, r.message);
  const crashes = [];
  for (const r of afterRows) {
    if (r.checkId !== checkId) continue;
    const key = `${r.owner}/${r.repo}`;
    if (isCrash(r.message) && !isCrash(before.get(key))) {
      crashes.push({ repo: key, message: (r.message || '').slice(0, 160) });
    }
  }
  return crashes;
}

// ── The gate ──
export function decideMerge({ lintHits, trainBase, trainPost, holdBase, holdPost, flips, crashes, fixtures }) {
  const reasons = [];
  if (lintHits.length) reasons.push(`anti-gaming lint: ${lintHits.join('; ')}`);

  // Catching MORE fixture mutants than baseline also counts as improvement —
  // a rewrite whose only benefit is sharper detection must not be auto-rejected
  // for "no measurable improvement" (harm checks below still apply in full).
  const improved =
    trainPost.severity < trainBase.severity ||
    (trainPost.checkItRate !== null && trainBase.checkItRate !== null &&
     trainPost.checkItRate <= trainBase.checkItRate - CHECKIT_IMPROVEMENT_MARGIN &&
     trainPost.avgScore !== null && trainBase.avgScore !== null &&
     trainPost.avgScore > trainBase.avgScore) ||
    (fixtures && fixtures.mutantsGained === true);
  if (!improved) {
    reasons.push(
      `no measurable improvement (severity ${trainBase.severity} -> ${trainPost.severity}, ` +
      `check-it ${pct(trainBase.checkItRate)} -> ${pct(trainPost.checkItRate)})`
    );
  }

  const harm = [];
  if (holdPost.severity > holdBase.severity) {
    harm.push(`hidden-set severity rose ${holdBase.severity} -> ${holdPost.severity}`);
  }
  const newPatterns = [
    ...trainPost.patternIds.filter(id => !trainBase.patternIds.includes(id)),
    ...holdPost.patternIds.filter(id => !holdBase.patternIds.includes(id)),
  ];
  if (newPatterns.length) harm.push(`new pattern(s) appeared: ${[...new Set(newPatterns)].join(', ')}`);
  if (flips.length) harm.push(`${flips.length} repo(s) got worse: ${flips.slice(0, 3).map(f => `${f.repo} (${f.from} -> ${f.to})`).join(', ')}`);
  if (crashes.length) harm.push(`${crashes.length} new crash(es): ${crashes.slice(0, 2).map(c => c.repo).join(', ')}`);

  // Fixture exam: mutants must not escape, positive controls must stay green.
  const fixturesOk = !fixtures || fixtures.ok;
  if (fixtures && !fixtures.ok) harm.push(...fixtures.reasons);

  return { verdict: improved && harm.length === 0 && lintHits.length === 0 && fixturesOk ? 'merge' : 'retry', reasons: [...reasons, ...harm] };
}

const pct = (x) => (x === null || x === undefined) ? 'n/a' : `${(x * 100).toFixed(0)}%`;

// ── Feedback message for a rejected rewrite (sent into the same specialist thread) ──
function buildFeedbackMessage(checkId, reasons, metrics) {
  const { trainBase, trainPost, holdBase, holdPost, flips, crashes, fixtureDetail } = metrics;
  const lines = [
    `VERIFICATION RESULTS for your previous '${checkId}' rewrite: it was REJECTED by the automated gate.`,
    '',
    'Measured on 15 train repos (the ones in the evidence) PLUS 8 hidden repos you have never seen:',
    `- Train pattern severity: ${trainBase.severity} -> ${trainPost.severity} (must go DOWN)`,
    `- Train check-it rate: ${pct(trainBase.checkItRate)} -> ${pct(trainPost.checkItRate)}`,
    `- Hidden-set pattern severity: ${holdBase.severity} -> ${holdPost.severity} (must NOT go up)`,
  ];
  if (flips.length) {
    lines.push('- Regressions (repos that got WORSE):');
    for (const f of flips.slice(0, 6)) lines.push(`    - ${f.repo}: ${f.from} -> ${f.to}`);
  }
  if (crashes.length) {
    lines.push('- New crashes:');
    for (const c of crashes.slice(0, 4)) lines.push(`    - ${c.repo}: ${c.message}`);
  }
  if (fixtureDetail && (fixtureDetail.mutantsMissed.length || fixtureDetail.positivesLost.length)) {
    lines.push('- Fixture exam failures (synthetic repos with known-correct answers):');
    for (const m of fixtureDetail.mutantsMissed.slice(0, 4)) {
      lines.push(`    - MISSED MUTANT ${m.slug}: ${m.note} — you returned '${m.status}', a correct specialist must flag it`);
    }
    for (const l of fixtureDetail.positivesLost.slice(0, 4)) {
      lines.push(`    - FALSE POSITIVE on ${l.slug}: ${l.note} — you returned '${l.status}', a correct specialist must pass it`);
    }
  }
  lines.push('', 'Why it was rejected:');
  for (const r of reasons) lines.push(`  - ${r}`);
  lines.push(
    '',
    'REMINDERS:',
    '- The fix must work on ANY real repo. Memorizing the evidence repos fails the hidden set.',
    '- NEVER hardcode repo names, owner names, or compare context.owner/context.repo to literals — a static lint blocks those outright.',
    '- Do not weaken detection just to make the severity number drop; regressions on individual repos are checked separately and also block merging.',
    '',
    'Now return the COMPLETE improved module in ONE ```javascript code block, keeping the contract exactly (same checkId, name, appliesTo). No prose.'
  );
  return lines.join('\n');
}

// ── Apply / restore candidate files ──
function applyCandidates(repoRoot, candidates, specFileMap) {
  const backups = new Map(); // relPath -> original code (filenames may differ from checkIds)
  for (const [checkId, code] of Object.entries(candidates)) {
    const rel = specialistFileFor(specFileMap, checkId);
    const p = path.join(repoRoot, rel);
    if (!fs.existsSync(p)) throw new Error(`${rel} not found for ${checkId}`);
    backups.set(rel, fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, code);
  }
  return backups;
}

function restoreCandidates(repoRoot, backups) {
  for (const [rel, code] of backups) {
    fs.writeFileSync(path.join(repoRoot, rel), code);
  }
}

// ── Merge one verified winner (PR for audit trail -> squash merge -> delete branch) ──
async function mergeWinner(gh, checkId, code, scoreComment, specFileMap) {
  const branch = `auto-fix/${checkId}`;
  const baseSha = await gh.defaultBranchSha();
  // Reusing a stale auto-fix/* branch makes the PR unmergeable: queued runs can be
  // pinned to an older main, and meanwhile main may have merged another rewrite of
  // the same specialist. Force-reset the branch to current main first, so the PR
  // always applies cleanly. (This is what stranded PRs #11/#12.)
  const existingSha = await gh.ensureBranch(branch, baseSha);
  if (existingSha !== baseSha) await gh.resetBranch(branch, baseSha);
  await gh.putFile(specialistFileFor(specFileMap, checkId), code, branch,
    `auto-fix(${checkId}): verified rewrite (auto-verify gate passed)`);
  const pr = await gh.openOrUpdatePr(branch,
    `auto-fix(${checkId}): verified rewrite`,
    scoreComment);
  await gh.commentOnPr(pr.number,
    `✅ **auto-verify gate: PASSED** — merging automatically.\n\n${scoreComment}`);
  const merge = await gh.mergePr(pr.number);
  await gh.deleteBranch(branch).catch(() => { /* already gone is fine */ });
  return { pr: pr.url, number: pr.number, mergeSha: merge.sha || null };
}

// ── Merge all winners, honestly ──
// Iterates a COPY of `winners`: removing entries from an array while for..of-ing
// it shifts the remaining entries left and the loop skips the next one — that bug
// once left never-attempted winners in the list, so the scoreboard reported them
// as "merged". After this runs, `winners` contains ONLY real, successful merges;
// every failed winner lands in `losers` with the error attached.
export async function mergeAllWinners(winners, losers, mergeOne, errLog = console.error) {
  const actuallyMerged = [];
  for (const w of [...winners]) {
    try {
      await mergeOne(w);
      actuallyMerged.push(w);
    } catch (err) {
      errLog(`    [${w.checkId}] MERGE FAILED: ${err.message} — leaving as loser`);
      losers.push({ ...w, reasons: [`merge failed: ${err.message}`] });
    }
  }
  winners.length = 0;
  winners.push(...actuallyMerged);
  return actuallyMerged;
}

// ── Scoreboard ──
function buildScoreboard({ winners, losers, rejected, merged, tagName, preMergeSha, usage, model, rounds, examSeed }) {
  const md = [
    '# Mach-Speed Auto-Verify Scoreboard', '',
    `**Generated:** ${new Date().toUTCString()}${examSeed ? ` · **Exam seed:** ${examSeed}` : ''}`,
    `**TL;DR:** ${winners.length} fix(es) passed the gate${merged ? ' & were merged' : ''} · ${losers.length} sent back to the AI (still not better) · ${rejected.length} blocked by safety checks`, '',
    '## How tonight\'s fixes were judged (plain English)', '',
    'Every AI rewrite was tested on **23 real repos**: 15 the AI was allowed to see in its',
    'evidence, plus **8 hidden repos it has never seen**. A fix is merged only if it is',
    'measurably better on the visible repos AND causes zero damage on the hidden ones —',
    'so memorizing the test answers cannot win. Anything that got worse was sent back to',
    'the AI with the failure details attached, and re-tested (up to ' + rounds + ' rounds).',
    'On top of that, every rewrite runs the **fixture exam**: synthetic repos with known-injected',
    'faults it must catch, and provably-correct repos it must not flag.', '',
    '## Results', '',
    '| Specialist | Severity (visible) | Severity (hidden) | Regressions | Decision |',
    '|-----------|--------------------|-------------------|-------------|----------|',
  ];
  const row = (r, decision) =>
    `| ${r.checkId} | ${r.trainBase.severity} → ${r.trainPost.severity} | ${r.holdBase.severity} → ${r.holdPost.severity} | ${r.flips.length ? `❌ ${r.flips.length}` : 'none'} | ${decision} |`;
  for (const w of winners) md.push(row(w, w.pr ? `✅ merged ([PR #${w.number}](${w.pr}))` : '✅ passed gate (not merged)'));
  for (const l of losers) md.push(row(l, '🔁 sent back — ' + l.reasons[0]));
  for (const r of rejected) md.push(`| ${r.checkId} | — | — | — | ⛔ ${r.reasons[0]} |`);
  md.push('');

  if (winners.length && merged) {
    md.push('## Merged tonight', '');
    for (const w of winners) {
      md.push(`- **${w.checkId}** — [PR #${w.number}](${w.pr}) (squash-merged). Severity ${w.trainBase.severity} → ${w.trainPost.severity}, check-it ${pct(w.trainBase.checkItRate)} → ${pct(w.trainPost.checkItRate)}, hidden set unharmed.`);
    }
    md.push('');
    md.push('### Undo (if anything looks wrong)', '');
    md.push(`Main was at commit \`${preMergeSha}\` before these merges, tagged **\`${tagName}\`**.`);
    md.push('Each merged PR also has a **Revert** button on GitHub — one click undoes one specialist.');
    md.push('');
  } else if (winners.length) {
    md.push('## Passed the gate (not merged)', '');
    for (const w of winners) {
      md.push(`- **${w.checkId}** — severity ${w.trainBase.severity} → ${w.trainPost.severity}, check-it ${pct(w.trainBase.checkItRate)} → ${pct(w.trainPost.checkItRate)}, hidden set unharmed.`);
    }
    md.push('');
  }
  if (losers.length) {
    md.push('## Sent back to the AI', '');
    for (const l of losers) {
      md.push(`- **${l.checkId}** — ${l.reasons.join('; ')}. The AI keeps its conversation history; the next run tries again with fresh evidence.`);
    }
    md.push('');
  }
  if (rejected.length) {
    md.push('## Blocked by safety lint (never tested)', '');
    for (const r of rejected) {
      md.push(`- **${r.checkId}** — ${r.reasons.join('; ')}`);
    }
    md.push('');
  }
  md.push('---');
  md.push(`*Model: ${model || '(none)'} · Moonshot tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out (${usage.calls} calls)*`);
  return md.join('\n');
}

// ── Exam seed rotation ──
// "Repos that change when the test is passed perfectly": when the heal run's
// fixture exam was fully green (every mutant caught, every control green), the
// persisted seed is bumped so the NEXT run generates fresh fixture surfaces.
// Idempotent within a run: the next seed is derived from the report's seed,
// not from re-reading state, so repeated calls write the same value.
async function maybeBumpExamSeed(gh, healReport) {
  if (!healReport?.examPerfect) return false;
  const seed = Number(healReport.examSeed) || 1;
  const next = seed + 1;
  if (!gh) {
    console.log(`  🎓 Perfect fixture exam (seed ${seed}) — no GitHub token, seed NOT bumped (re-run in CI to rotate)`);
    return false;
  }
  try {
    await gh.putFile(
      EXAM_SEED_PATH,
      JSON.stringify({ seed: next, previousSeed: seed, bumpedAt: new Date().toISOString() }, null, 2) + '\n',
      STATE_BRANCH,
      `exam: perfect score at seed ${seed} — rotate to seed ${next}`,
    );
  } catch (err) {
    // Rotation is nice-to-have; a failed bump must never kill a verify run.
    console.warn(`  WARN: Perfect fixture exam at seed ${seed}, but the seed bump failed (${err.message}) — continuing; a later run retries the rotation`);
    return false;
  }
  console.log(`  🎓 Perfect fixture exam at seed ${seed} — exam rotated to seed ${next} for the next run`);
  return true;
}

// ── Main ──
export async function autoverify(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv);
  const repoRoot = process.cwd();

  console.log('\n  Mach-Speed Auto-Verify (verify-then-merge gate)');
  console.log('  ================================================');
  console.log(`  Evidence: ${opt.evidence} | Proposed: ${opt.proposed} | mode: ${opt.dryRun ? 'dry-run' : opt.pr ? 'verify+merge' : 'verify only'}`);

  // ── 1. Evidence gate: never verify against an incomplete run ──
  const reportPath = path.join(opt.evidence, 'report.json');
  if (!fs.existsSync(reportPath)) throw new Error(`no report.json in ${opt.evidence} — run auto-heal.js first`);
  const healReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (healReport.incomplete) {
    console.error('\n  REFUSING TO VERIFY: the evidence run was INCOMPLETE.');
    console.error('  Baselines from partial data are garbage. Re-run auto-heal.js with GITHUB_TOKEN.\n');
    process.exit(2);
  }

  // ── 1.5 GitHub handle + exam seed rotation ──
  // The seed bump must happen BEFORE the no-candidates early exits below: a
  // perfect exam usually means auto-fix had no gaps to work on, so "nothing to
  // verify" is exactly the path where the exam must rotate.
  // installFetchMiddleware MUST run before any GitHub WRITE below — without it
  // requests go out unauthenticated: reads on a public repo still work, but the
  // exam-seed.json PUT fails with 401 (this exact bug crashed a real run).
  installFetchMiddleware();
  const repoSlug = opt.repo || process.env.GITHUB_REPOSITORY || null;
  let gh = null;
  if (process.env.GITHUB_TOKEN && repoSlug) {
    const [owner, repo] = repoSlug.split('/');
    gh = new GitHubApi(owner, repo);
    await gh.ensureBranch(STATE_BRANCH, await gh.defaultBranchSha());
  }
  if (opt.pr && !gh) throw new Error('--pr needs GITHUB_TOKEN and GITHUB_REPOSITORY (or --repo owner/name)');
  await maybeBumpExamSeed(gh, healReport);

  // ── 2. Load candidates ──
  if (!fs.existsSync(opt.proposed)) {
    console.log(`  No ${opt.proposed}/ directory — auto-fix produced nothing. Nothing to verify.`);
    return { winners: [], losers: [], rejected: [] };
  }
  const severityRank = new Map((healReport.specialistReports || []).map(r => [r.checkId, r.severityScore || 0]));
  // Filenames may differ from checkIds (auth-config lives in
  // authentication-configuration.js) — resolve real paths once, up front.
  const specFileMap = buildSpecialistFileMap(repoRoot);
  let candidates = fs.readdirSync(opt.proposed)
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .filter(id => specFileMap.has(id));
  if (opt.only) candidates = candidates.filter(id => opt.only.includes(id));
  candidates.sort((a, b) => (severityRank.get(b) || 0) - (severityRank.get(a) || 0));
  candidates = candidates.slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) {
    console.log('  No proposed fixes to verify. Suite state unchanged.');
    return { winners: [], losers: [], rejected: [] };
  }
  console.log(`  Candidates (${candidates.length}): ${candidates.join(', ')}`);

  // Holdout set (overridable for testing)
  let holdoutRepos = HOLDOUT_REPOS;
  if (opt.holdout) {
    holdoutRepos = JSON.parse(fs.readFileSync(opt.holdout, 'utf8'));
    console.log(`  Using custom holdout set (${holdoutRepos.length} repos)`);
  }

  // ── 3. Up-front validation + anti-gaming lint ──
  const state = new Map(); // checkId -> { code, reasons[], history[] }
  for (const checkId of candidates) {
    const code = fs.readFileSync(path.join(opt.proposed, `${checkId}.js`), 'utf8');
    const lintHits = antiGameLint(checkId, code);
    const srcProblems = validateModuleSource(checkId, code);
    const rtProblems = srcProblems.length ? [] : validateModuleRuntime(checkId, code, repoRoot);
    const reasons = [
      ...(lintHits.length ? [`anti-gaming lint: ${lintHits.join('; ')}`] : []),
      ...srcProblems.map(p => `contract: ${p}`),
      ...rtProblems.map(p => `validation: ${p}`),
    ];
    state.set(checkId, { code, reasons, history: [], lintHits });
    if (reasons.length) console.log(`    [${checkId}] pre-test rejected: ${reasons[0]}`);
  }

  // ── 4. Services ──
  installFetchMiddleware();
  const moonshot = new Moonshot();
  const threads = new ThreadStore(gh, path.join(repoRoot, 'threads'));
  // Thread saves commit to the shared state branch — serialize them (the Moonshot
  // chats themselves run in parallel) so concurrent branch commits can't race.
  let saveChain = Promise.resolve();
  const saveLock = (fn) => { const p = saveChain.then(fn); saveChain = p.catch(() => {}); return p; };

  // ── 4.5 Snapshot every repo once (train + hidden, parallel tarballs) so the
  // sweeps below read from disk instead of re-downloading each repo every round.
  if (process.env[REPO_CACHE_ENV]) {
    const all = [...TEST_REPOS, ...holdoutRepos];
    const pre = await prefetchRepos(all, path.resolve(process.env[REPO_CACHE_ENV]), { token: process.env.GITHUB_TOKEN });
    const ready = pre.ok.length + pre.cached.length;
    console.log(`  Repo snapshots: ${ready}/${all.length} ready` +
      (pre.failed.length ? ` — ${pre.failed.length} fetch live (${pre.failed.map(f => f.slug).join(', ')})` : ''));
  }

  // ── 4.6 Materialize the fixture exam (mutants + positive controls) into the
  // same snapshot cache — the sweeps below then measure them like real repos.
  let fixtureManifest = null;
  let examSeed = null;
  if (process.env[REPO_CACHE_ENV]) {
    // Same exam heal ran: prefer the report's seed (immune to the rotation
    // bump above); fall back to resolving state only for older reports.
    examSeed = Number(healReport.examSeed) || await resolveExamSeed();
    const generated = generateFixtures(examSeed);
    fixtureManifest = await buildFixtures(path.resolve(process.env[REPO_CACHE_ENV]), [...FIXTURES, ...generated]);
    console.log(`  Fixture exam: ${fixtureManifest.length} synthetic repos ready (mutants + positive controls) · exam seed ${examSeed}`);
  } else {
    console.log('  Fixture exam: SKIPPED (no repo cache dir configured)');
  }

  // ── 5. Baselines ──
  const runnerPath = ensureRunner(repoRoot);
  const winners = [], finalLosers = [];
  try {
    console.log('\n  Phase 1: baselines (current, unmodified specialists)');
    const trainBase = await loadTrainBaseline(opt.evidence, repoRoot, runnerPath);
    const holdBase = await runSweep(repoRoot, runnerPath, holdoutRepos, 'hidden-baseline');
    const baseRows = [...trainBase.rows, ...holdBase.rows];

    // Fixture baseline: how many mutants the CURRENT specialists catch, and
    // whether the positive controls are green. Candidates are measured against this.
    const fixtureRepos = fixtureManifest
      ? fixtureManifest.map(f => ({ owner: f.owner, repo: f.repo, expected: f.expectedType }))
      : null;
    const fixBase = fixtureRepos
      ? await runSweep(repoRoot, runnerPath, fixtureRepos, 'fixtures-base')
      : null;
    const fixBaseMap = fixBase ? evaluateFixtureRows(fixBase.rows, fixtureManifest) : null;

    // ── 6. Test rounds ──
    let active = candidates.filter(id => state.get(id).reasons.length === 0);
    let feedbackOnly = candidates.filter(id => state.get(id).reasons.length > 0); // never swept until fixed

    for (let round = 1; round <= opt.rounds; round++) {
      if (active.length) {
        console.log(`\n  Phase 2.${round}: verification sweep (round ${round}/${opt.rounds}) — ${active.length} candidate(s) on ${TEST_REPOS.length} visible + ${holdoutRepos.length} hidden repos`);
      } else {
        console.log(`\n  Phase 2.${round}: no test-ready candidates this round — feedback only`);
      }
      const roundLosers = [];

      if (active.length) {
        const codes = Object.fromEntries(active.map(id => [id, state.get(id).code]));
        const backups = applyCandidates(repoRoot, codes, specFileMap);
        let postRows;
        let fixPostMap = null;
        try {
          const trainPost = await runSweep(repoRoot, runnerPath, TEST_REPOS, `train-r${round}`);
          const holdPost = await runSweep(repoRoot, runnerPath, holdoutRepos, `hidden-r${round}`);
          postRows = { train: trainPost, hold: holdPost };
          if (fixtureRepos) {
            const fixPost = await runSweep(repoRoot, runnerPath, fixtureRepos, `fixtures-r${round}`);
            fixPostMap = evaluateFixtureRows(fixPost.rows, fixtureManifest);
          }
        } finally {
          restoreCandidates(repoRoot, backups);
        }

        for (const checkId of active) {
          const s = state.get(checkId);
          const metrics = {
            trainBase: computeMetrics(checkId, trainBase.rows, trainBase.repoTypeMap, TEST_REPOS),
            trainPost: computeMetrics(checkId, postRows.train.rows, postRows.train.repoTypeMap, TEST_REPOS),
            holdBase: computeMetrics(checkId, holdBase.rows, holdBase.repoTypeMap, holdoutRepos),
            holdPost: computeMetrics(checkId, postRows.hold.rows, postRows.hold.repoTypeMap, holdoutRepos),
            flips: regressionFlips(baseRows, [...postRows.train.rows, ...postRows.hold.rows], checkId),
            crashes: newCrashes(baseRows, [...postRows.train.rows, ...postRows.hold.rows], checkId),
          };
          // Fixture gate (per candidate), ABSOLUTE mode: a rewrite must catch EVERY
          // mutant for its check (zero missed) and keep every positive control green.
          // Catching MORE mutants than baseline counts as a merge-worthy improvement
          // (see decideMerge) — so closing a known gap is always mergeable.
          const baseCaught = fixBaseMap?.get(checkId)?.mutantsCaught ?? 0;
          const postCaught = fixPostMap?.get(checkId)?.mutantsCaught ?? 0;
          const fixtureGate = (fixBaseMap && fixPostMap)
            ? {
                ...fixtureVerdict(
                  new Map([[checkId, fixBaseMap.get(checkId)]]),
                  new Map([[checkId, fixPostMap.get(checkId)]]),
                  { positivesMode: 'absolute', mutantsMode: 'absolute' }),
                mutantsGained: postCaught > baseCaught,
              }
            : null;
          const decision = decideMerge({ lintHits: s.lintHits, ...metrics, fixtures: fixtureGate });
          const fixtureDetail = fixPostMap ? fixPostMap.get(checkId) : null;
          const record = { checkId, code: s.code, ...metrics, fixtureDetail, examSeed, reasons: decision.reasons, rounds: round };
          s.history.push(record);
          if (decision.verdict === 'merge') {
            console.log(`    ✅ ${checkId}: PASSED the gate (severity ${metrics.trainBase.severity}→${metrics.trainPost.severity}, hidden ${metrics.holdBase.severity}→${metrics.holdPost.severity}, 0 regressions)`);
            winners.push(record);
          } else {
            console.log(`    🔁 ${checkId}: rejected — ${decision.reasons[0]}`);
            roundLosers.push(record);
          }
        }
      }

      // Everything not merged this round: rejected-up-front items + swept losers
      const needsRetry = [
        ...feedbackOnly.map(id => ({ checkId: id, reasons: state.get(id).reasons, untested: true, ...blankMetrics() })),
        ...roundLosers,
      ];
      feedbackOnly = [];

      if (round >= opt.rounds || needsRetry.length === 0) {
        finalLosers.push(...needsRetry);
        break;
      }

      // ── 7. Feedback loop: send failures back to Moonshot, collect next versions ──
      if (!moonshot.apiKey) {
        console.log('\n  No MOONSHOT_API_KEY — skipping feedback retries (losers reported only).');
        finalLosers.push(...needsRetry);
        break;
      }
      console.log(`\n  Phase 3.${round}: sending ${needsRetry.length} rejection(s) back to Moonshot for another attempt`);
      active = [];
      let rateLimitedOut = false;
      await pool(needsRetry, FEEDBACK_CONCURRENCY, async (loser) => {
        const { checkId } = loser;
        const s = state.get(checkId);
        try {
          const feedback = loser.untested
            ? `Your previous '${checkId}' rewrite was REJECTED before testing:\n${loser.reasons.map(r => `- ${r}`).join('\n')}\n\nReturn the COMPLETE corrected module in ONE \`\`\`javascript code block. No prose. Never hardcode repo/owner names or compare context.owner/context.repo to string literals.`
            : buildFeedbackMessage(checkId, loser.reasons, loser);
          const thread = await threads.load(checkId);
          const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...thread, { role: 'user', content: feedback }];
          await sleep(CALL_SPACING_MS);
          const reply = await moonshot.chat(messages);
          messages.push({ role: 'assistant', content: reply });
          await saveLock(() => threads.save(checkId, messages.slice(1)));

          const code2 = extractModule(reply);
          const srcProblems = code2 ? validateModuleSource(checkId, code2) : ['no javascript code block in reply'];
          const lint2 = code2 && !srcProblems.length ? antiGameLint(checkId, code2) : [];
          const rt2 = code2 && !srcProblems.length && !lint2.length ? validateModuleRuntime(checkId, code2, repoRoot) : [];
          const reasons2 = [
            ...srcProblems.map(p => `contract: ${p}`),
            ...(lint2.length ? [`anti-gaming lint: ${lint2.join('; ')}`] : []),
            ...rt2.map(p => `validation: ${p}`),
          ];
          if (!code2 || reasons2.length) {
            console.log(`    [${checkId}] retry ${round + 1} invalid: ${reasons2[0] || 'extraction failed'} — will feed back next round`);
            s.reasons = reasons2.length ? reasons2 : ['no javascript code block in reply'];
            feedbackOnly.push(checkId);
          } else {
            console.log(`    [${checkId}] retry ${round + 1} ready for testing`);
            s.code = code2;
            s.reasons = [];
            s.lintHits = [];
            active.push(checkId);
          }
        } catch (err) {
          console.error(`    [${checkId}] feedback call failed: ${err.message}`);
          s.reasons = [`moonshot error: ${err.message}`];
          feedbackOnly.push(checkId);
          if (/429|rate limit/i.test(err.message)) rateLimitedOut = true;
        }
      });
      if (rateLimitedOut) {
        console.error('    Moonshot rate limit persists — ending retries; untested candidates are reported, never merged.');
        for (const id of [...new Set([...feedbackOnly, ...active])]) {
          finalLosers.push({ checkId: id, reasons: state.get(id).reasons.length ? state.get(id).reasons : ['aborted: moonshot rate limit'], untested: true, ...blankMetrics() });
        }
        active = []; feedbackOnly = [];
        break;
      }
      // Next loop iteration sweeps `active` (if any) and routes `feedbackOnly`
      // straight back into the feedback phase — no test sweep is wasted on
      // candidates that have not produced a valid module yet.
      if (!active.length && !feedbackOnly.length) break; // nothing left to try
    }

    // Anything still in feedback limbo after the loop is a final loser
    for (const id of feedbackOnly) finalLosers.push({ checkId: id, reasons: state.get(id).reasons, untested: true, ...blankMetrics() });
  } finally {
    cleanupRunner(repoRoot);
  }

  // De-dupe final losers (a candidate appears once, with its latest reasons)
  const loserMap = new Map();
  for (const l of finalLosers) loserMap.set(l.checkId, l);
  const allLosers = [...loserMap.values()];

  // Report split: tested-and-still-worse vs never-passed-validation (lint/contract).
  const losers = [], rejected = [];
  for (const l of allLosers) {
    (state.get(l.checkId).history.length > 0 ? losers : rejected).push(l);
  }

  // ── 8. Merge winners ──
  let tagName = null, preMergeSha = null;
  if (winners.length && opt.pr && !opt.dryRun && gh) {
    console.log(`\n  Phase 4: merging ${winners.length} verified winner(s)`);
    preMergeSha = await gh.defaultBranchSha();
    tagName = `pre-autofix-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 12)}`;
    await gh.createTag(tagName, preMergeSha).catch(err => console.warn(`    tag creation failed (non-fatal): ${err.message}`));
    await mergeAllWinners(winners, losers, async (w) => {
      const comment = scoreCommentFor(w);
      const res = await mergeWinner(gh, w.checkId, w.code, comment, specFileMap);
      w.pr = res.pr; w.number = res.number; w.mergeSha = res.mergeSha;
      console.log(`    ✅ ${w.checkId}: merged via PR #${res.number} (${res.pr})`);
    });
  } else if (winners.length) {
    console.log(`\n  ${winners.length} winner(s) verified but NOT merged (${opt.dryRun ? 'dry-run' : 'no --pr'}).`);
  }

  // ── 9. Reports ──
  const report = {
    generatedAt: new Date().toISOString(),
    rounds: opt.rounds,
    examSeed,
    merged: winners.map(w => ({ checkId: w.checkId, pr: w.pr || null, mergeSha: w.mergeSha || null })),
    sentBack: losers.map(l => ({ checkId: l.checkId, reasons: l.reasons })),
    lintRejected: rejected.map(r => ({ checkId: r.checkId, reasons: r.reasons })),
    tagName, preMergeSha,
    model: moonshot.model, usage: moonshot.usage,
  };
  fs.writeFileSync('verify-report.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('verify-report.md', buildScoreboard({
    winners, losers, rejected, merged: winners.some(w => w.pr), tagName, preMergeSha,
    usage: moonshot.usage, model: moonshot.model, rounds: opt.rounds, examSeed,
  }));

  console.log('\n  ══ SCOREBOARD ══');
  console.log(`  ✅ merged:      ${winners.length ? winners.map(w => w.checkId).join(', ') : '(none)'}`);
  console.log(`  🔁 sent back:   ${losers.length ? losers.map(l => l.checkId).join(', ') : '(none)'}`);
  console.log(`  ⛔ lint-blocked: ${rejected.length ? rejected.map(r => r.checkId).join(', ') : '(none)'}`);
  if (tagName) console.log(`  ↩️  undo point:  tag ${tagName} (${preMergeSha})`);
  console.log('  Full report: verify-report.md / verify-report.json\n');
  return report;
}

function blankMetrics() {
  const m = { resultCount: 0, severity: 0, patternIds: [], checkItRate: null, avgScore: null };
  return { trainBase: m, trainPost: m, holdBase: m, holdPost: m, flips: [], crashes: [] };
}

function scoreCommentFor(w) {
  return [
    `### auto-verify measurements for \`${w.checkId}\``,
    '',
    '| Set | Severity before | Severity after | Check-it before | Check-it after |',
    '|-----|-----------------|----------------|-----------------|----------------|',
    `| Visible (15 repos) | ${w.trainBase.severity} | ${w.trainPost.severity} | ${pct(w.trainBase.checkItRate)} | ${pct(w.trainPost.checkItRate)} |`,
    `| Hidden (8 repos the AI never saw) | ${w.holdBase.severity} | ${w.holdPost.severity} | ${pct(w.holdBase.checkItRate)} | ${pct(w.holdPost.checkItRate)} |`,
    '',
    `Regression flips: **${w.flips.length}** · New crashes: **${w.crashes.length}** · Anti-gaming lint: **clean**`,
    ...(w.fixtureDetail ? [
      '',
      `Fixture exam (synthetic repos with known answers): mutants **${w.fixtureDetail.mutantsCaught}/${w.fixtureDetail.mutantsTotal}** caught · positive controls **${w.fixtureDetail.positivesGreen}/${w.fixtureDetail.positivesTotal}** green${w.examSeed ? ` · exam seed **${w.examSeed}**` : ''}`,
    ] : []),
    '',
    '_Merged automatically by auto-verify.js — revert this PR from the GitHub UI if anything looks off._',
  ].join('\n');
}

// ── Run only when executed directly ──
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  autoverify().catch(err => {
    console.error('\n  Fatal error:', err.message);
    process.exit(1);
  });
}
