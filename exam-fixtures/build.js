/**
 * exam-fixtures/build.js — materialize fixture specs as on-disk repo snapshots
 * in the exact format repo-cache.js serves:
 *
 *   <cacheDir>/<owner>__<repo>/             the fixture's files (relative paths)
 *   <cacheDir>/<owner>__<repo>.meta.json    { owner, repo, defaultBranch, ref, fetchedAt }
 *
 * meta.json is the snapshot success marker (repo-cache refuses to serve a
 * dir without it), and defaultBranch must be a non-empty string for shape-1
 * (metadata) requests to be cache-served.
 *
 * Module rules: ESM, Node 20, zero npm dependencies, no top-level side
 * effects — importing this file never touches disk or network.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './specs.js';

/** Fake owner for ALL fixtures — can never collide with a real GitHub org. */
export const FIXTURE_OWNER = 'mach-speed-exam';

/** All fixture slugs (owner/repo) — used by the anti-gaming lint. */
export function fixtureSlugs() {
  return FIXTURES.map((f) => f.slug);
}

/** Split and validate a fixture slug 'owner/repo'. */
export function parseSlug(slug) {
  const parts = typeof slug === 'string' ? slug.split('/') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid fixture slug "${slug}" — expected "owner/repo"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Write every fixture's files + meta.json into cacheDir.
 * Idempotent: each fixture dir is removed and rewritten, so rebuilds never
 * leave stale files behind.
 *
 * Returns the manifest: array of
 *   { owner, repo, slug, kind, expectedType, expected, expect, note }
 * (`expected` aliases `expectedType` so entries drop straight into
 * auto-verify's runSweep as { owner, repo, expected } repo entries.)
 */
export async function buildFixtures(cacheDir, fixtures = FIXTURES) {
  if (!cacheDir || typeof cacheDir !== 'string') {
    throw new Error('buildFixtures(cacheDir) requires a cache directory path');
  }
  const root = path.resolve(cacheDir);
  await fsp.mkdir(root, { recursive: true });

  const manifest = [];
  for (const spec of fixtures) {
    const { owner, repo } = parseSlug(spec.slug);
    const dir = path.join(root, `${owner}__${repo}`);

    await fsp.rm(dir, { recursive: true, force: true }); // idempotent rebuild
    await fsp.mkdir(dir, { recursive: true });

    const resolvedDir = path.resolve(dir);
    for (const [rel, content] of Object.entries(spec.files)) {
      const abs = path.resolve(resolvedDir, ...rel.split('/'));
      // A fixture path must never escape its snapshot dir.
      if (abs !== resolvedDir && !abs.startsWith(resolvedDir + path.sep)) {
        throw new Error(`Fixture ${spec.slug}: path "${rel}" escapes the snapshot dir`);
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content);
    }

    const meta = {
      owner,
      repo,
      defaultBranch: 'main',
      ref: 'fixture',
      fetchedAt: Date.now(),
    };
    await fsp.writeFile(
      path.join(root, `${owner}__${repo}.meta.json`),
      JSON.stringify(meta, null, 2) + '\n',
    );

    manifest.push({
      owner,
      repo,
      slug: spec.slug,
      kind: spec.kind,
      expectedType: spec.expectedType,
      expected: spec.expectedType, // runSweep-compatible alias
      expect: spec.expect,
      note: spec.note,
    });
  }
  return manifest;
}
