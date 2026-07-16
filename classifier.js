// classifier.js — v5: Monorepo with examples = framework signal

import { RepoType } from './contract.js';

const FRAMEWORK_NAMES = new Set([
  'express', 'fastify', 'koa', 'hono',
  'next', 'nuxt', 'sveltekit',
]);

const LIBRARY_NAMES = new Set([
  'react', 'react-dom', 'vue', 'svelte', 'angular',
  'preact', 'solid-js', 'lit', 'alpinejs',
  '@angular/core', '@angular/common',
]);

export async function classifyRepo(tree, packageJson) {
  const scores = { empty: 0, library: 0, deployable: 0, server: 0, framework: 0, tool: 0 };

  const hasPkgJson = tree.includes('package.json');
  const fileCount = tree.length;
  const hasSrc = tree.some(p => p.startsWith('src/'));
  const hasLib = tree.some(p => p.startsWith('lib/'));
  const hasPackages = tree.some(p => p.startsWith('packages/'));
  const hasPages = tree.some(p => p.startsWith('pages/') || p.startsWith('app/'));
  const hasExamples = tree.some(p => p.startsWith('examples/'));
  const hasBin = tree.some(p => p.startsWith('bin/'));
  const hasDockerfile = tree.includes('Dockerfile');
  const hasAstroConfig = tree.some(p => p.includes('astro.config'));
  const hasNextConfig = tree.some(p => p.includes('next.config'));
  const hasNuxtConfig = tree.some(p => p.includes('nuxt.config'));
  const hasViteConfig = tree.some(p => p.includes('vite.config'));

  const deps = packageJson?.dependencies || {};
  const devDeps = packageJson?.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  const scripts = packageJson?.scripts || {};
  const keywords = packageJson?.keywords || [];
  const pkgName = packageJson?.name || '';
  const hasPeerDeps = !!packageJson?.peerDependencies;
  const hasMainField = !!(packageJson?.main || packageJson?.module);

  const hasServerDep = !!(allDeps.express || allDeps.fastify || allDeps.koa || allDeps.hono);
  const hasNext = !!allDeps.next;
  const hasNuxt = !!allDeps.nuxt;
  const hasAstro = !!allDeps.astro;
  const hasServerPaths = tree.some(p => /\/(server|api|routes)\//.test(p));
  const kwLib = keywords.some(k => /^(react|vue|svelte|angular|preact|ui|component|library)$/.test(k));
  const kwFramework = keywords.includes('framework');
  const kwCli = keywords.some(k => k.includes('cli'));
  const hasBuild = !!scripts.build;
  const hasStart = !!(scripts.start || scripts.dev || scripts.serve);

  // ── EMPTY ──
  if (!hasPkgJson && fileCount < 5) scores.empty += 10;

  // ── TOOL ──
  if (hasBin) scores.tool += 3;
  if (allDeps.commander || allDeps.yargs) scores.tool += 3;
  if (kwCli) scores.tool += 2;
  if (hasPages || hasBuild || hasDockerfile) scores.tool -= 4;

  // ── LIBRARY ──
  if (hasPeerDeps) scores.library += 5;
  if (kwLib) scores.library += 4;
  if (LIBRARY_NAMES.has(pkgName)) scores.library += 8;
  if (hasMainField) scores.library += 2;
  // Monorepo without strong deployable/framework signals → likely library
  if (hasPackages && !hasPages && !hasNext && !hasNuxt && !hasServerDep && !kwFramework) {
    scores.library += 3;
  }
  // Penalties
  if (hasServerDep) scores.library -= 3;
  if (hasPages) scores.library -= 3;
  if (hasNext || hasNuxt) scores.library -= 2;
  if (hasLib && hasExamples) scores.library -= 1;

  // ── FRAMEWORK ──
  if (FRAMEWORK_NAMES.has(pkgName)) scores.framework += 8;
  if (kwFramework) scores.framework += 3;
  if (hasLib && hasExamples) scores.framework += 3;
  if (hasPackages && (hasSrc || hasLib)) scores.framework += 3;
  if (hasServerDep && hasLib && !hasPages) scores.framework += 2;
  if (hasPackages && hasLib && hasServerDep) scores.framework += 3;
  if ((hasNext || hasNextConfig) && hasPackages && kwFramework) scores.framework += 3;
  if ((hasNuxt || hasNuxtConfig) && hasPackages && kwFramework) scores.framework += 3;
  // Monorepo with examples but no app pages = framework/platform (not a deployable app)
  if (hasPackages && hasExamples && !hasPages) scores.framework += 10;
  // Penalties
  if (hasPages) scores.framework -= 3;
  if (!hasLib && !hasPackages) scores.framework -= 2;
  if (hasAstroConfig && hasPackages) scores.framework -= 5;

  // ── SERVER ──
  if (hasServerDep) scores.server += 3;
  if (hasServerPaths) scores.server += 2;
  if (hasLib && hasExamples) scores.server -= 3;
  if (hasPackages) scores.server -= 2;
  if (hasPages) scores.server -= 2;

  // ── DEPLOYABLE ──
  if (hasNext || hasNextConfig) scores.deployable += 2;
  if (hasNuxt || hasNuxtConfig) scores.deployable += 2;
  if (hasAstro || hasAstroConfig) scores.deployable += 3;
  if (hasPages) scores.deployable += 2;
  if (hasBuild) scores.deployable += 1;
  if (hasViteConfig) scores.deployable += 2;
  if (hasDockerfile) scores.deployable += 2;
  if (hasStart) scores.deployable += 1;
  // Monorepo using a meta-framework = website (not the framework itself)
  if (hasPackages && (hasNext || hasNuxt) && !kwFramework) scores.deployable += 3;

  // ── Pick winner ──
  const entries = Object.entries(scores)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) {
    if (hasPkgJson && hasStart) return RepoType.DEPLOYABLE;
    if (hasPkgJson && hasBuild) return RepoType.LIBRARY;
    if (hasPkgJson) return RepoType.DEPLOYABLE;
    return RepoType.UNKNOWN;
  }

  const winner = entries[0][0];
  return RepoType[winner.toUpperCase()] || RepoType.UNKNOWN;
}

// Debug version: returns { result, scores, signals } for inspection
export async function classifyRepoDebug(tree, packageJson) {
  const scores = { empty: 0, library: 0, deployable: 0, server: 0, framework: 0, tool: 0 };

  const hasPkgJson = tree.includes('package.json');
  const fileCount = tree.length;
  const hasSrc = tree.some(p => p.startsWith('src/'));
  const hasLib = tree.some(p => p.startsWith('lib/'));
  const hasPackages = tree.some(p => p.startsWith('packages/'));
  const hasPages = tree.some(p => p.startsWith('pages/') || p.startsWith('app/'));
  const hasExamples = tree.some(p => p.startsWith('examples/'));
  const hasBin = tree.some(p => p.startsWith('bin/'));
  const hasDockerfile = tree.includes('Dockerfile');
  const hasAstroConfig = tree.some(p => p.includes('astro.config'));
  const hasNextConfig = tree.some(p => p.includes('next.config'));
  const hasNuxtConfig = tree.some(p => p.includes('nuxt.config'));
  const hasViteConfig = tree.some(p => p.includes('vite.config'));

  const deps = packageJson?.dependencies || {};
  const devDeps = packageJson?.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  const scripts = packageJson?.scripts || {};
  const keywords = packageJson?.keywords || [];
  const pkgName = packageJson?.name || '';
  const hasPeerDeps = !!packageJson?.peerDependencies;
  const hasMainField = !!(packageJson?.main || packageJson?.module);

  const hasServerDep = !!(allDeps.express || allDeps.fastify || allDeps.koa || allDeps.hono);
  const hasNext = !!allDeps.next;
  const hasNuxt = !!allDeps.nuxt;
  const hasAstro = !!allDeps.astro;
  const hasServerPaths = tree.some(p => /\/(server|api|routes)\//.test(p));
  const kwLib = keywords.some(k => /^(react|vue|svelte|angular|preact|ui|component|library)$/.test(k));
  const kwFramework = keywords.includes('framework');
  const kwCli = keywords.some(k => k.includes('cli'));
  const hasBuild = !!scripts.build;
  const hasStart = !!(scripts.start || scripts.dev || scripts.serve);

  // ── EMPTY ──
  if (!hasPkgJson && fileCount < 5) scores.empty += 10;

  // ── TOOL ──
  if (hasBin) scores.tool += 3;
  if (allDeps.commander || allDeps.yargs) scores.tool += 3;
  if (kwCli) scores.tool += 2;
  if (hasPages || hasBuild || hasDockerfile) scores.tool -= 4;

  // ── LIBRARY ──
  if (hasPeerDeps) scores.library += 5;
  if (kwLib) scores.library += 4;
  if (LIBRARY_NAMES.has(pkgName)) scores.library += 8;
  if (hasMainField) scores.library += 2;
  if (hasPackages && !hasPages && !hasNext && !hasNuxt && !hasServerDep && !kwFramework) {
    scores.library += 3;
  }
  if (hasServerDep) scores.library -= 3;
  if (hasPages) scores.library -= 3;
  if (hasNext || hasNuxt) scores.library -= 2;
  if (hasLib && hasExamples) scores.library -= 1;

  // ── FRAMEWORK ──
  if (FRAMEWORK_NAMES.has(pkgName)) scores.framework += 8;
  if (kwFramework) scores.framework += 3;
  if (hasLib && hasExamples) scores.framework += 3;
  if (hasPackages && (hasSrc || hasLib)) scores.framework += 3;
  if (hasServerDep && hasLib && !hasPages) scores.framework += 2;
  if (hasPackages && hasLib && hasServerDep) scores.framework += 3;
  if ((hasNext || hasNextConfig) && hasPackages && kwFramework) scores.framework += 3;
  if ((hasNuxt || hasNuxtConfig) && hasPackages && kwFramework) scores.framework += 3;
  // Monorepo with examples but no app pages = framework/platform
  if (hasPackages && hasExamples && !hasPages) scores.framework += 10;
  // Penalties
  if (hasPages) scores.framework -= 3;
  if (!hasLib && !hasPackages) scores.framework -= 2;
  if (hasAstroConfig && hasPackages) scores.framework -= 5;

  // ── SERVER ──
  if (hasServerDep) scores.server += 3;
  if (hasServerPaths) scores.server += 2;
  if (hasLib && hasExamples) scores.server -= 3;
  if (hasPackages) scores.server -= 2;
  if (hasPages) scores.server -= 2;

  // ── DEPLOYABLE ──
  if (hasNext || hasNextConfig) scores.deployable += 2;
  if (hasNuxt || hasNuxtConfig) scores.deployable += 2;
  if (hasAstro || hasAstroConfig) scores.deployable += 3;
  if (hasPages) scores.deployable += 2;
  if (hasBuild) scores.deployable += 1;
  if (hasViteConfig) scores.deployable += 2;
  if (hasDockerfile) scores.deployable += 2;
  if (hasStart) scores.deployable += 1;
  if (hasPackages && (hasNext || hasNuxt) && !kwFramework) scores.deployable += 3;

  const entries = Object.entries(scores)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  let result;
  if (entries.length === 0) {
    if (hasPkgJson && hasStart) result = RepoType.DEPLOYABLE;
    else if (hasPkgJson && hasBuild) result = RepoType.LIBRARY;
    else if (hasPkgJson) result = RepoType.DEPLOYABLE;
    else result = RepoType.UNKNOWN;
  } else {
    const winner = entries[0][0];
    result = RepoType[winner.toUpperCase()] || RepoType.UNKNOWN;
  }

  return { result, scores, signals: { pkgName, hasPeerDeps, kwLib, kwFramework, hasLib, hasExamples, hasPackages, hasPages, hasNext, hasNuxt, hasServerDep, hasBuild, hasStart } };
}
