/**
 * repo-cache.js — local tarball cache for the Mach-Speed repo analyzer.
 *
 * Instead of hitting the GitHub API / raw host for every analysis run, repos are
 * prefetched once (codeload tarball + one metadata call) into a local directory:
 *
 *   <cacheDir>/<owner>__<repo>/            extracted tarball (top-level dir stripped)
 *   <cacheDir>/<owner>__<repo>.meta.json   { owner, repo, defaultBranch, ref, fetchedAt }
 *
 * `createCachedFetch` then returns a fetch(url, opts)-compatible function that
 * serves the analyzer's three URL shapes from that directory and transparently
 * delegates everything else to the real fetch.
 *
 * Module rules: ESM, Node 20, zero npm dependencies, and no top-level side
 * effects — importing this file never touches the network or the disk.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Environment variable that points the analyzer at a cache directory. */
export const REPO_CACHE_ENV = 'MACH_SPEED_REPO_CACHE';

/** Default freshness window for prefetched repos: 6 hours. */
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/* --------------------------------------------------------------------------
 * Small filesystem helpers (all failure-tolerant: "unknown" reads as "no").
 * ------------------------------------------------------------------------ */

/** Path of the extracted repo dir: <cacheDir>/<owner>__<repo> */
export function cacheDirFor(cacheDir, owner, repo) {
  return path.join(cacheDir, `${owner}__${repo}`);
}

/** Path of the sidecar metadata file: <cacheDir>/<owner>__<repo>.meta.json */
function metaPathFor(cacheDir, owner, repo) {
  return path.join(cacheDir, `${owner}__${repo}.meta.json`);
}

async function pathIsDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null; // missing / unreadable / malformed JSON -> treated as absent
  }
}

/* --------------------------------------------------------------------------
 * pool — generic async worker pool.
 * ------------------------------------------------------------------------ */

/**
 * Process `items` with at most `concurrency` workers in flight, dequeuing in
 * array order. `worker(item, ctrl)` may call `ctrl.stop()` to prevent NEW
 * items from being dequeued; already in-flight workers run to completion.
 * A worker rejection rejects the pool (unless the worker catches it itself).
 */
export async function pool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  // At least one lane so an empty item list or a bogus concurrency is harmless.
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, list.length || 1));
  let nextIndex = 0;
  let stopped = false;
  const ctrl = {
    stop() { stopped = true; },
  };
  const runners = [];
  for (let i = 0; i < lanes; i++) {
    runners.push((async () => {
      // Re-check `stopped` only between items: in-flight work always finishes.
      while (!stopped && nextIndex < list.length) {
        const item = list[nextIndex++];
        await worker(item, ctrl); // rejection propagates out of Promise.all below
      }
    })());
  }
  await Promise.all(runners);
}

/* --------------------------------------------------------------------------
 * prefetchRepos — download + extract repos in parallel; never throws for an
 * individual repo failure (each failure is reported in `failed`).
 * ------------------------------------------------------------------------ */

export async function prefetchRepos(repos, cacheDir, opts = {}) {
  const {
    token = null,
    concurrency = 6,
    ref = 'HEAD',
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    verbose = true,
  } = opts || {};

  const ok = [];
  const cached = [];
  const failed = [];
  const list = Array.isArray(repos) ? repos : [];
  const log = (...args) => { if (verbose) console.error('[prefetch]', ...args); };
  // Authorization header is sent only when a token was provided.
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  await fsp.mkdir(cacheDir, { recursive: true });

  await pool(list, concurrency, async (entry) => {
    const owner = entry && entry.owner;
    const repo = entry && entry.repo;
    const slug = `${owner}/${repo}`;
    try {
      if (!owner || !repo) throw new Error('repo entry must be {owner, repo}');

      const destDir = cacheDirFor(cacheDir, owner, repo);
      const metaPath = metaPathFor(cacheDir, owner, repo);

      // Skip logic: extracted dir AND a meta.json fetched within maxAgeMs.
      const [dirExists, meta] = await Promise.all([pathIsDir(destDir), readJsonFile(metaPath)]);
      const fresh = !!meta
        && Number.isFinite(meta.fetchedAt)
        && (Date.now() - meta.fetchedAt) < maxAgeMs;
      if (dirExists && fresh) {
        cached.push(slug);
        log(`cached    ${slug}`);
        return;
      }

      // Download the codeload tarball to a temp file, then extract with the
      // system tar. Any failure (HTTP status, tar error, disk error) fails
      // this repo only.
      await fsp.mkdir(destDir, { recursive: true }); // destDir created first
      const tgz = path.join(
        os.tmpdir(),
        `mach-speed-${owner}__${repo}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`,
      );
      try {
        log(`download  ${slug}@${ref}`);
        // globalThis.fetch is looked up at call time (tests/host can stub it).
        const res = await globalThis.fetch(
          `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`,
          { headers },
        );
        if (!res.ok) throw new Error(`codeload HTTP ${res.status} for ${slug}@${ref}`);
        await fsp.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
        await execFileAsync('tar', ['-xzf', tgz, '-C', destDir, '--strip-components=1']);
      } finally {
        await fsp.rm(tgz, { force: true }).catch(() => {});
      }

      // Default-branch discovery: exactly ONE API call. Failure here does NOT
      // fail the repo — defaultBranch just stays null (cached fetch will then
      // pass metadata requests through to the network).
      let defaultBranch = null;
      try {
        const metaRes = await globalThis.fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
        if (metaRes.ok) {
          const mj = await metaRes.json();
          if (mj && typeof mj.default_branch === 'string' && mj.default_branch) {
            defaultBranch = mj.default_branch;
          }
        }
      } catch {
        /* defaultBranch stays null; the prefetch still counts as success */
      }

      await fsp.writeFile(
        metaPath,
        JSON.stringify({ owner, repo, defaultBranch, ref, fetchedAt: Date.now() }, null, 2) + '\n',
      );
      ok.push(slug);
      log(`fetched   ${slug} (defaultBranch=${defaultBranch})`);
    } catch (err) {
      failed.push({ slug, error: String((err && err.message) || err) });
      log(`FAILED    ${slug}: ${(err && err.message) || err}`);
    }
  });

  return { ok, cached, failed };
}

/* --------------------------------------------------------------------------
 * createCachedFetch — fetch(url, opts)-compatible wrapper.
 *
 * Recognized URL shapes (anything else -> fallbackFetch, same url+opts):
 *
 *   1. https://api.github.com/repos/<o>/<r>            (exactly, no suffix)
 *      -> served from <o>__<r>.meta.json if it exists and defaultBranch is a
 *         non-empty string; otherwise fallback.
 *
 *   2. https://api.github.com/repos/<o>/<r>/git/trees/<ref>?recursive=1
 *      (ref may contain slashes, query ignored)
 *      -> if <o>__<r>/ exists, walk it (regular files only, POSIX relative
 *         paths, `.git` defensively skipped) and return a synthetic tree;
 *         otherwise fallback.
 *
 *   3. https://raw.githubusercontent.com/<o>/<r>/<branch>/<path...>
 *      -> if <o>__<r>/ exists, serve <path...> from disk (404 Response when
 *         missing / a directory); otherwise fallback.
 *
 *   4. Everything else -> fallbackFetch unchanged.
 *
 * SECURITY (shape 3): the URL path is percent-decoded per segment and any
 * decoded `..` segment is refused (request falls back to the network, it is
 * never served). As a second barrier the resolved absolute path must stay
 * inside the repo dir, and symlinks are realpath-checked so a tarball can
 * never smuggle a pointer outside the repo dir either.
 * ------------------------------------------------------------------------ */

const RE_GH_META = /^\/repos\/([^/]+)\/([^/]+)$/; // shape 1 (pathname only, no query)
const RE_GH_TREES = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/; // shape 2, ref = $3
const RE_RAW = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/; // shape 3: o / r / branch / path...

/** Recursively list regular files under rootDir as sorted POSIX relative paths. */
async function listRepoFiles(rootDir) {
  const out = [];
  async function walk(dir, prefix) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === '.git') continue; // tarballs have none; skip defensively
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name; // forward slashes
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), rel);
      else if (ent.isFile()) out.push(rel); // regular files only (no symlinks etc.)
    }
  }
  await walk(rootDir, '');
  out.sort();
  return out;
}

function jsonResponse(bodyObj) {
  return new Response(JSON.stringify(bodyObj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function notFoundResponse() {
  return new Response('404: Not Found', { status: 404 });
}

/**
 * Serve shape 3 from `repoRoot`. Returns a Response (200 or 404) when the
 * cache can answer confidently, or null when the request should fall back to
 * the network (weird / traversal-ish input). Never serves a byte from
 * outside `repoRoot`.
 */
async function serveRawFromRepo(repoRoot, urlPath) {
  // urlPath is still percent-encoded. Decode per-segment so encoded dots
  // (%2e%2e) are caught; WHATWG URL parsing has already collapsed literal
  // ".." segments, so encoded ones are the dangerous case.
  let segments;
  try {
    segments = urlPath.split('/').map((s) => decodeURIComponent(s));
  } catch {
    return null; // malformed percent-encoding -> weird input -> fallback
  }
  if (segments.some((seg) => seg === '..')) return null; // traversal -> fallback

  const root = path.resolve(repoRoot);
  const abs = path.resolve(root, ...segments);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null; // escaped root -> fallback

  // Defense in depth: resolve symlinks and re-check containment.
  let realRoot;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    return null; // repo dir vanished mid-request -> not confident -> fallback
  }
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch {
    return notFoundResponse(); // does not exist
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return notFoundResponse(); // symlink points outside the repo: refuse
  }

  try {
    const st = await fsp.stat(real);
    if (!st.isFile()) return notFoundResponse(); // directory (or special file)
    const content = await fsp.readFile(real, 'utf8');
    return new Response(content, { status: 200 });
  } catch {
    return notFoundResponse();
  }
}

/**
 * Try to answer `u` (a parsed URL) from the cache. Returns a Response on a
 * confident cache answer (including a confident 404) or null to delegate to
 * the network fallback.
 */
/** A snapshot counts only when the extract finished AND its success marker exists
 *  (a failed/interrupted prefetch can leave an empty <o>__<r>/ dir behind — that
 *  must fall back to the network, never shadow it with an empty tree). */
async function snapshotReady(dir, metaPath) {
  return (await pathIsDir(dir)) && (await readJsonFile(metaPath)) !== null;
}

async function tryServeFromCache(u, cacheDir) {
  const host = u.hostname;

  if (host === 'api.github.com') {
    // Shape 2 first: /repos/<o>/<r>/git/trees/<ref> (query ignored by pathname).
    let m = RE_GH_TREES.exec(u.pathname);
    if (m) {
      const [, owner, repo] = m;
      const dir = cacheDirFor(cacheDir, owner, repo);
      if (!(await snapshotReady(dir, metaPathFor(cacheDir, owner, repo)))) return null;
      const files = await listRepoFiles(dir);
      return jsonResponse({
        sha: 'cache',
        truncated: false,
        tree: files.map((p) => ({ path: p, mode: '100644', type: 'blob' })),
      });
    }
    // Shape 1: /repos/<o>/<r> exactly.
    m = RE_GH_META.exec(u.pathname);
    if (m) {
      const [, owner, repo] = m;
      const meta = await readJsonFile(metaPathFor(cacheDir, owner, repo));
      if (meta && typeof meta.defaultBranch === 'string' && meta.defaultBranch.length > 0) {
        return jsonResponse({
          default_branch: meta.defaultBranch,
          full_name: `${owner}/${repo}`,
        });
      }
      return null; // no meta, or no known default branch -> network
    }
    return null; // some other GitHub API endpoint
  }

  if (host === 'raw.githubusercontent.com') {
    const m = RE_RAW.exec(u.pathname);
    if (!m) return null;
    const [, owner, repo, /* branch */, relPath] = m;
    const dir = cacheDirFor(cacheDir, owner, repo);
    if (!(await snapshotReady(dir, metaPathFor(cacheDir, owner, repo)))) return null;
    return serveRawFromRepo(dir, relPath);
  }

  return null; // any other host
}

/**
 * Returns a fetch(url, opts)-compatible function. Cache hits are served from
 * disk with no network access; anything not confidently cached is delegated
 * to `fallbackFetch` with the original url and opts.
 */
export function createCachedFetch(cacheDir, fallbackFetch = globalThis.fetch) {
  return async function cachedFetch(url, opts) {
    let u = null;
    try {
      // Accept string, URL, or Request-like inputs.
      const href = typeof url === 'string' ? url : (url && (url.href || url.url)) || String(url);
      u = new URL(href);
    } catch {
      u = null;
    }
    if (u) {
      try {
        const hit = await tryServeFromCache(u, cacheDir);
        if (hit) return hit;
      } catch {
        // Unexpected cache-layer error (perms, races, ...): the entry is not
        // confidently cached, so fall through to the network instead of
        // failing the caller.
      }
    }
    return fallbackFetch(url, opts);
  };
}
