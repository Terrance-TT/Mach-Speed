/**
 * exam-fixtures/evaluate.js — evaluation + verdict for fixture sweeps.
 *
 * PURE functions: no I/O, no imports, no side effects.
 *
 * Row shape (auto-verify runSweep rows): { owner, repo, checkId, status, ... }
 *
 * Missing-row rule: when a specialist never ran on a fixture (e.g. the six
 * server-scoped checks are filtered out by shouldRun() on tool/library
 * repoTypes), there is no row for that (repo, checkId) pair. evaluateFixtureRows
 * scores a missing row as 'not-applicable' — the check legitimately bowed out.
 * Consequences:
 *   - controls: 'not-applicable' in the allowed set counts as green;
 *   - mutants:  'not-applicable' is never in the mutant expect set, so a
 *               targeted specialist that doesn't even run counts as a MISS.
 */

const VALID_STATUSES = new Set(['pass', 'fail', 'check-it', 'not-applicable']);

function emptyBucket() {
  return {
    mutantsTotal: 0,
    mutantsCaught: 0,
    mutantsMissed: [],
    positivesTotal: 0,
    positivesGreen: 0,
    positivesLost: [],
  };
}

/**
 * evaluateFixtureRows(rows, manifest)
 *   -> Map<checkId, {
 *        mutantsTotal, mutantsCaught,               // caught = status in expect set
 *        mutantsMissed: [{ slug, note, status }],
 *        positivesTotal, positivesGreen,
 *        positivesLost: [{ slug, note, status }],   // status NOT in allowed set
 *      }>
 */
export function evaluateFixtureRows(rows, manifest) {
  // Index rows by `${owner}/${repo}${checkId}`; first row wins
  // (duplicate rows for the same check would double-count otherwise).
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.checkId) continue;
    const key = `${row.owner}/${row.repo}${row.checkId}`;
    if (!index.has(key)) index.set(key, row);
  }

  const out = new Map();
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    const slug = entry.slug || `${entry.owner}/${entry.repo}`;
    for (const [checkId, allowed] of Object.entries(entry.expect || {})) {
      if (!out.has(checkId)) out.set(checkId, emptyBucket());
      const bucket = out.get(checkId);

      const row = index.get(`${entry.owner}/${entry.repo}${checkId}`);
      // Missing row = specialist never ran = not-applicable (see header).
      const status = row && VALID_STATUSES.has(row.status) ? row.status : 'not-applicable';

      if (entry.kind === 'mutant') {
        bucket.mutantsTotal += 1;
        if (allowed.includes(status)) {
          bucket.mutantsCaught += 1;
        } else {
          bucket.mutantsMissed.push({ slug, note: entry.note || '', status });
        }
      } else {
        bucket.positivesTotal += 1;
        if (allowed.includes(status)) {
          bucket.positivesGreen += 1;
        } else {
          bucket.positivesLost.push({ slug, note: entry.note || '', status });
        }
      }
    }
  }
  return out;
}

/**
 * The gate rule:
 *
 * fixtureVerdict(baseMap, postMap, { positivesMode, mutantsMode })
 *   -> { ok: boolean, reasons: [string] }
 *
 * - mutants 'ratchet' (default): for every checkId, post.mutantsCaught >= base.mutantsCaught,
 *   else reason: "caught X -> Y mutants (detection got weaker)"
 * - mutants 'absolute': post must catch EVERY mutant (zero missed), else reason.
 *   Use once the exam is trusted — a rewrite may not leave any mutant uncaught.
 * - positives 'absolute': post must be 100% green (any positivesLost entry -> reason)
 * - positives 'ratchet':  only NEWLY lost vs base -> reason
 */
export function fixtureVerdict(baseMap, postMap, { positivesMode = 'absolute', mutantsMode = 'ratchet' } = {}) {
  if (positivesMode !== 'absolute' && positivesMode !== 'ratchet') {
    throw new Error(`positivesMode must be 'absolute' or 'ratchet', got "${positivesMode}"`);
  }
  if (mutantsMode !== 'absolute' && mutantsMode !== 'ratchet') {
    throw new Error(`mutantsMode must be 'absolute' or 'ratchet', got "${mutantsMode}"`);
  }
  const reasons = [];
  const checkIds = new Set([...(baseMap ? baseMap.keys() : []), ...(postMap ? postMap.keys() : [])]);

  for (const checkId of checkIds) {
    const base = (baseMap && baseMap.get(checkId)) || emptyBucket();
    const post = (postMap && postMap.get(checkId)) || emptyBucket();

    // Mutants.
    if (mutantsMode === 'absolute') {
      const missed = post.mutantsTotal - post.mutantsCaught;
      if (missed > 0) {
        reasons.push(
          `fixture mutants: ${checkId} still misses ${missed}/${post.mutantsTotal} mutant(s): ${post.mutantsMissed.map((m) => `${m.slug} (${m.status})`).join(', ')}`,
        );
      }
    } else if (post.mutantsCaught < base.mutantsCaught) {
      reasons.push(
        `fixture mutants: ${checkId} caught ${base.mutantsCaught} -> ${post.mutantsCaught} mutants (detection got weaker)`,
      );
    }

    // Positives.
    if (positivesMode === 'absolute') {
      for (const lost of post.positivesLost) {
        reasons.push(`fixture positives: ${checkId} lost ${lost.slug} (status: ${lost.status})`);
      }
    } else {
      const baseLost = new Set(base.positivesLost.map((l) => l.slug));
      for (const lost of post.positivesLost) {
        if (!baseLost.has(lost.slug)) {
          reasons.push(`fixture positives: ${checkId} newly lost ${lost.slug} (status: ${lost.status})`);
        }
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
