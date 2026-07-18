#!/usr/bin/env node
/**
 * Try It — a friendly, hands-on testing tool for the Mach-Speed analyzer.
 *
 * Built for NON-TECHNICAL testers. Point it at a GitHub repo and it grades
 * how deployable that repo is, in plain English:
 *
 *   node try-it.js --repo owner/name                                  # grade a repo
 *   node try-it.js --repo owner/name --mode compare                   # before/after the last improvement
 *   node try-it.js --repo owner/name --mode compare --tag pre-autofix-20240101
 *
 * "compare" mode runs the analyzer twice: once with the specialists exactly
 * as they were at a snapshot tag (the "before"), and once with the current
 * specialists (the "after"). Your working files are always put back, even if
 * something crashes half-way through.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const ANALYSIS_TIMEOUT_MS = 240_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// The 12 checks the analyzer runs. Each lives at specialists/<id>.js.
const SPECIALIST_IDS = [
  'dynamic-port', 'cors', 'database-config', 'env-vars', 'lockfile',
  'host-binding', 'node-version', 'start-script', 'build-step',
  'static-files', 'health-check', 'secrets',
];

const STATUS_EMOJI = { pass: '✅', 'check-it': '⚠️', fail: '❌', 'not-applicable': '➖' };
const STATUS_RANK = { pass: 3, 'check-it': 2, fail: 1, 'not-applicable': 0 };
const STATUS_WORD = { pass: 'passing', fail: 'failing', 'check-it': 'needs a look', 'not-applicable': 'not applicable' };
const STATUS_GROUP_ORDER = ['fail', 'check-it', 'pass', 'not-applicable'];
const STATUS_GROUP_LABEL = {
  fail: 'Needs fixing',
  'check-it': 'Worth a look',
  pass: 'Looking good',
  'not-applicable': 'Not applicable for this repo',
};

const USAGE = `Try It — give the Mach-Speed analyzer a spin.

Usage:
  node try-it.js --repo owner/name [--mode analyze|compare] [--tag pre-autofix-XXX]

Options:
  --repo   The GitHub repo to grade, e.g. --repo expressjs/express   (required)
  --mode   analyze = just grade it (this is the default)
           compare = grade it with the OLD checks and the CURRENT checks,
                     then show exactly what the latest improvement changed
  --tag    Which old snapshot to compare against
           (leave it out to use the newest pre-autofix-* snapshot)
`;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested — no I/O in here)
// ---------------------------------------------------------------------------

/**
 * Render a plain-English scorecard block.
 * @param {object} scorecard the analyzer's scorecard
 * @param {{ title?: string }} opts
 * @returns {string}
 */
export function renderScorecard(scorecard, { title } = {}) {
  if (!scorecard || typeof scorecard !== 'object') {
    throw new Error('renderScorecard needs a scorecard object');
  }
  const lines = [];
  if (title) {
    lines.push(title);
    lines.push('='.repeat(Math.min(title.length, 70)));
  }
  lines.push(`Score: ${scorecard.score}/10 — ${scorecard.verdict}`);

  const s = scorecard.summary || {};
  const total = s.total ?? '?';
  lines.push(
    `${total} check${total === 1 ? '' : 's'} ran: ${s.passed ?? 0} passed · ${s.failed ?? 0} failed · `
    + `${s.checkIt ?? 0} worth a look · ${s.notApplicable ?? 0} not applicable`,
  );
  lines.push('');

  const checks = Array.isArray(scorecard.checks) ? scorecard.checks : [];
  for (const status of STATUS_GROUP_ORDER) {
    const group = checks.filter((c) => c.status === status);
    if (group.length === 0) continue;
    lines.push(`${STATUS_GROUP_LABEL[status]} (${group.length}):`);
    for (const c of group) {
      const msg = c.message ? ` (${c.message})` : '';
      lines.push(`  ${STATUS_EMOJI[status]} ${c.name || c.id}${msg}`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Compare two scorecards check-by-check.
 * @returns {{ flips: Array<{id:string, name:string, from:string, to:string, direction:'improved'|'regressed'|'changed'}>,
 *             scoreBefore: number, scoreAfter: number, summaryLine: string }}
 */
export function diffScorecards(before, after) {
  const beforeById = new Map(((before && before.checks) || []).map((c) => [c.id, c]));
  const afterById = new Map(((after && after.checks) || []).map((c) => [c.id, c]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];

  const flips = [];
  for (const id of ids) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    if (!b || !a) continue; // check only exists on one side — nothing meaningful to say
    if (b.status === a.status) continue;
    let direction;
    if (b.status === 'not-applicable' || a.status === 'not-applicable') {
      direction = 'changed'; // can't rank "not applicable" against real results
    } else {
      const delta = (STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0);
      direction = delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'changed';
    }
    flips.push({ id, name: a.name || b.name || id, from: b.status, to: a.status, direction });
  }

  const improved = flips.filter((f) => f.direction === 'improved').length;
  const regressed = flips.filter((f) => f.direction === 'regressed').length;
  const changed = flips.filter((f) => f.direction === 'changed').length;
  const summaryLine = flips.length === 0
    ? 'No checks changed status.'
    : `${flips.length} check${flips.length === 1 ? '' : 's'} changed status: `
      + `${improved} improved, ${regressed} regressed, ${changed} changed.`;

  return {
    flips,
    scoreBefore: before ? before.score : undefined,
    scoreAfter: after ? after.score : undefined,
    summaryLine,
  };
}

/**
 * Render a plain-English before/after comparison.
 * @param {ReturnType<typeof diffScorecards>} diff
 * @param {{ tag?: string }} opts
 * @returns {string}
 */
export function renderDiff(diff, { tag } = {}) {
  const lines = [];
  if (tag) lines.push(`What changed since the "${tag}" snapshot:`);
  const delta = diff.scoreAfter - diff.scoreBefore;
  const deltaText = delta >= 0 ? `+${delta}` : `${delta}`;
  lines.push(`Score ${diff.scoreBefore}/10 → ${diff.scoreAfter}/10 (${deltaText})`);
  lines.push('');

  if (!diff.flips || diff.flips.length === 0) {
    lines.push("No differences — the improvement didn't change this repo's results.");
  } else {
    lines.push(diff.summaryLine);
    lines.push('');
    const sections = [
      ['improved', 'Got better:'],
      ['regressed', 'Got worse:'],
      ['changed', 'Changed:'],
    ];
    for (const [direction, heading] of sections) {
      const items = diff.flips.filter((f) => f.direction === direction);
      if (items.length === 0) continue;
      lines.push(heading);
      for (const f of items) {
        const from = STATUS_WORD[f.from] || f.from;
        const to = STATUS_WORD[f.to] || f.to;
        lines.push(`  • ${f.name}: ${from} → ${to}`);
      }
      lines.push('');
    }
  }

  if (diff.scoreAfter > diff.scoreBefore) {
    lines.push("Nice — the latest improvements raised this repo's score. That's the improvement doing its job! 🎉");
  } else if (diff.scoreAfter < diff.scoreBefore) {
    lines.push("Caution: the score went DOWN after the latest changes. That's probably not intended — please report this to the Mach-Speed team so they can take a look.");
  }
  return lines.join('\n').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// Child-process runner (central.js statically imports the specialists, so a
// fresh node process is required whenever the specialist files change)
// ---------------------------------------------------------------------------

const RUNNER_SOURCE = `import { installFetchMiddleware } from './auto-heal.js';
import { analyzeRepo } from './central.js';
installFetchMiddleware({ verbose: false });
const [owner, repo] = process.argv.slice(2);
try {
  const r = await analyzeRepo(owner, repo);
  process.stdout.write(JSON.stringify({ ok: true, repoType: r.repoType, scorecard: r.scorecard }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
}
`;

/** The runner writes its JSON result last; earlier stdout may contain logs. */
function parseRunnerStdout(stdout) {
  const marker = stdout.lastIndexOf('{"ok"');
  const start = marker >= 0 ? marker : stdout.indexOf('{');
  if (start < 0) throw new Error('the analysis finished without producing a result');
  return JSON.parse(stdout.slice(start));
}

/**
 * Run one full analysis in a fresh node process.
 * @param {string} repoRoot mach-speed repo root (contains central.js, specialists/)
 */
async function runAnalysis(repoRoot, owner, repo) {
  const runnerPath = path.join(repoRoot, '.try-it-runner.mjs');
  await fs.promises.writeFile(runnerPath, RUNNER_SOURCE, 'utf8');
  try {
    const { stdout } = await execFileAsync(process.execPath, [runnerPath, owner, repo], {
      cwd: repoRoot,
      env: process.env,
      timeout: ANALYSIS_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const data = parseRunnerStdout(stdout);
    if (!data.ok) throw new Error(data.error || 'the analysis failed');
    return data;
  } finally {
    await fs.promises.rm(runnerPath, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Git helpers for compare mode
// ---------------------------------------------------------------------------

async function resolveTag(repoRoot, tagArg) {
  if (tagArg) return { tag: tagArg };
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'git', ['tag', '-l', 'pre-autofix-*', '--sort=-creatordate'],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    ));
  } catch (err) {
    throw new Error(`couldn't list the snapshot tags — are you running this from the Mach-Speed project folder? (${(err && err.message) || err})`);
  }
  const tag = stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0] || null;
  return { tag };
}

/**
 * Read every specialist file as it was at <tag>. Files that didn't exist yet
 * at that tag are reported in `missing` and skipped (current version is used).
 */
async function readTaggedSpecialists(repoRoot, tag) {
  const files = new Map();
  const missing = [];
  for (const id of SPECIALIST_IDS) {
    try {
      const { stdout } = await execFileAsync(
        'git', ['show', `${tag}:specialists/${id}.js`],
        { cwd: repoRoot, maxBuffer: MAX_BUFFER },
      );
      files.set(id, stdout);
    } catch {
      missing.push(id);
    }
  }
  return { files, missing };
}

/**
 * Swap in the tagged specialist files, run fn(), then ALWAYS put the
 * original files back — even if fn() crashes.
 */
async function withTaggedSpecialists(repoRoot, taggedFiles, fn) {
  const backupDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'try-it-backup-'));
  const hadOriginal = new Set();
  try {
    for (const id of SPECIALIST_IDS) {
      const live = path.join(repoRoot, 'specialists', `${id}.js`);
      if (fs.existsSync(live)) {
        await fs.promises.copyFile(live, path.join(backupDir, `${id}.js`));
        hadOriginal.add(id);
      }
    }
    for (const [id, content] of taggedFiles) {
      await fs.promises.writeFile(path.join(repoRoot, 'specialists', `${id}.js`), content, 'utf8');
    }
    return await fn();
  } finally {
    for (const id of SPECIALIST_IDS) {
      const live = path.join(repoRoot, 'specialists', `${id}.js`);
      try {
        if (hadOriginal.has(id)) {
          await fs.promises.copyFile(path.join(backupDir, `${id}.js`), live);
        } else if (taggedFiles.has(id)) {
          await fs.promises.rm(live, { force: true }); // didn't exist before — remove the tagged copy
        }
      } catch (err) {
        console.warn(`Warning: couldn't fully restore specialists/${id}.js (${(err && err.message) || err})`);
      }
    }
    await fs.promises.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Optional speed hook — soft dependency, loaded dynamically so this file
// still works when repo-cache.js doesn't exist.
// ---------------------------------------------------------------------------

async function maybePrefetch(owner, repo) {
  const cacheDir = process.env.MACH_SPEED_REPO_CACHE;
  if (!cacheDir) return;
  try {
    const mod = await import('./repo-cache.js');
    console.log('Warming up the local repo cache to make this faster…');
    await mod.prefetchRepos([{ owner, repo }], cacheDir, { token: process.env.GITHUB_TOKEN });
    console.log('Cache ready.');
  } catch (err) {
    console.warn(`Note: couldn't warm the cache (${(err && err.message) || err}) — continuing anyway, this will just be a little slower.`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { mode: 'analyze' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--repo' || a === '--mode' || a === '--tag') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`missing a value after ${a}`);
      args[a.slice(2)] = v;
      i += 1;
    } else {
      throw new Error(`I didn't understand "${a}". Run with --help to see the options.`);
    }
  }
  if (typeof args.tag === 'string' && args.tag.trim() === '') delete args.tag;
  return args;
}

function failFriendly(message) {
  console.error('');
  console.error(`Sorry, something went wrong: ${message}`);
  console.error('If this keeps happening, please report it to the Mach-Speed team.');
  process.exitCode = 1;
}

async function runAnalyze(repoRoot, owner, repo) {
  console.log(`Analyzing ${owner}/${repo}… (this usually takes about a minute)`);
  const result = await runAnalysis(repoRoot, owner, repo);
  console.log('');
  console.log(renderScorecard(result.scorecard, { title: `${owner}/${repo} (${result.repoType})` }));
}

async function runCompare(repoRoot, owner, repo, tagArg) {
  const { tag } = await resolveTag(repoRoot, tagArg);
  if (!tag) {
    console.log("There's no before/after snapshot to compare against yet —");
    console.log('run analyze mode, or wait for the first auto-fix run to complete.');
    return;
  }
  console.log(`Comparing against snapshot: ${tag}`);

  const { files, missing } = await readTaggedSpecialists(repoRoot, tag);
  if (missing.length > 0) {
    console.log(`Note: ${missing.length} check${missing.length === 1 ? '' : 's'} didn't exist at that snapshot (${missing.join(', ')}) — the current version will be used for both runs.`);
  }
  if (files.size === 0) {
    throw new Error(`couldn't read any check files from snapshot "${tag}". Does that tag exist? Try: git fetch --tags`);
  }

  console.log(`Running the BEFORE analysis with the old (${tag}) checks… (about a minute)`);
  const before = await withTaggedSpecialists(repoRoot, files, () => runAnalysis(repoRoot, owner, repo));
  console.log('Old checks put away — your current files are back in place.');

  console.log('Running the AFTER analysis with the current checks… (about a minute)');
  const after = await runAnalysis(repoRoot, owner, repo);

  console.log('');
  console.log(`BEFORE (${tag}): Score: ${before.scorecard.score}/10 — ${before.scorecard.verdict}`);
  console.log(`AFTER (current main): Score: ${after.scorecard.score}/10 — ${after.scorecard.verdict}`);
  console.log('');
  console.log(renderDiff(diffScorecards(before.scorecard, after.scorecard), { tag }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.repo) {
    console.error('Which repo should I look at? Tell me with --repo owner/name, e.g.:');
    console.error('  node try-it.js --repo expressjs/express');
    process.exitCode = 1;
    return;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    console.error(`Hmm, "${args.repo}" doesn't look like a GitHub repo. Use the owner/name form, e.g. --repo expressjs/express`);
    process.exitCode = 1;
    return;
  }
  if (args.mode !== 'analyze' && args.mode !== 'compare') {
    console.error(`Unknown mode "${args.mode}" — pick "analyze" or "compare".`);
    process.exitCode = 1;
    return;
  }

  const [owner, repo] = args.repo.split('/');
  const repoRoot = process.cwd(); // run from the Mach-Speed project folder

  await maybePrefetch(owner, repo);

  if (args.mode === 'compare') {
    await runCompare(repoRoot, owner, repo, args.tag);
  } else {
    await runAnalyze(repoRoot, owner, repo);
  }
}

// Only run the CLI when executed directly (tests import the pure helpers).
const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((err) => failFriendly((err && err.message) || String(err)));
}
