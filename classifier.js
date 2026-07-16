// classifier.js — Pure signal-scoring repo classifier. No early returns.
// Each repo type accumulates points. Highest positive score wins.

import { RepoType } from './contract.js';

// Framework packages (the framework itself, not an app using it)
const FRAMEWORK_NAMES = new Set([
  'express', 'fastify', 'koa', 'hono',         // server frameworks
  'next', 'nuxt', 'sveltekit',                  // meta-frameworks
]);

// Library packages
const LIBRARY_NAMES = new Set([
  'react', 'react-dom', 'vue', 'svelte', 'angular',
  'preact', 'solid-js', 'lit', 'alpinejs',
  '@angular/core', '@angular/common',
]);

export async function classifyRepo(tree, packageJson) {
  const scores = { empty: 0, library: 0, deployable: 0, server: 0, framework: 0, tool: 0 };

  // ── Tree features ──
  const fileCount = tree.length;
  const hasPkgJson = tree.includes('package.json');
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

  // ── Package.json features ──
  const deps = packageJson?.dependencies || {};
  const devDeps = packageJson?.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  const depNames = Object.keys(allDeps);
  const scripts = packageJson?.scripts || {};
  const keywords = packageJson?.keywords || [];
  const pkgName = packageJson?.name || '';
  const hasPeerDeps = !!packageJson?.peerDependencies;
  const hasMainField = !!(packageJson?.main || packageJson?.module);
  const hasWorkspaces = !!packageJson?.workspaces;

  // Derived
  const hasServerDep = !!(allDeps.express || allDeps.fastify || allDeps.koa || allDeps.hono);
  const hasNext = !!allDeps.next;
  const hasNuxt = !!allDeps.nuxt;
  const hasAstro = !!allDeps.astro;
  const hasServerPaths = tree.some(p => /\/(server|api|routes)\//.test(p));
  const kwLib = keywords.some(k => /^(react|vue|svelte|angular|preact|ui|component|library)$/.test(k));
  const kwFramework = keywords.includes('framework');
  const kwCli = keywords.some(k => k.includes('cli'));
  const hasBuild = !!scripts.build;
  const hasStart = !!(scripts.start || scripts.dev);

  // ── EMPTY: almost nothing here ──
  if (!hasPkgJson && fileCount < 5) scores.empty += 10;

  // ── TOOL: CLI-focused ──
  if (hasBin) scores.tool += 3;
  if (allDeps.commander || allDeps.yargs) scores.tool += 3;
  if (kwCli) scores.tool += 2;
  // Not a tool if it has app/deployment signals
  if (hasPages || hasBuild || hasDockerfile) scores.tool -= 4;

  // ── LIBRARY: consumed by other packages ──
  if (hasPeerDeps) scores.library += 5;
  if (kwLib) scores.library += 3;
  if (LIBRARY_NAMES.has(pkgName)) scores.library += 5;
  if (hasMainField) scores.library += 2;
  // Penalties
  if (hasServerDep) scores.library -= 3;
  if (hasPages) scores.library -= 3;
  if (hasNext || hasNuxt) scores.library -= 2; // using Next/Nuxt = building an app
  if (hasLib && hasExamples) scores.library -= 1; // might be a framework

  // ── FRAMEWORK: infrastructure other apps build on ──
  if (FRAMEWORK_NAMES.has(pkgName)) scores.framework += 6;
  if (kwFramework) scores.framework += 4;
  if (hasLib && hasExamples) scores.framework += 3;
  if (hasPackages && (hasSrc || hasLib)) scores.framework += 2;
  if (hasServerDep && hasLib && !hasPages) scores.framework += 2;
  // Monorepo with core lib + server code = framework platform
  if (hasPackages && hasLib && hasServerDep) scores.framework += 3;
  // The Next.js/Nuxt frameworks themselves: monorepo + framework keyword
  if ((hasNext || hasNextConfig) && hasPackages && kwFramework) scores.framework += 3;
  if ((hasNuxt || hasNuxtConfig) && hasPackages && kwFramework) scores.framework += 3;
  // Penalties
  if (hasPages) scores.framework -= 3;  // has app pages = deployable, not framework
  if (!hasLib && !hasPackages) scores.framework -= 2; // needs structure
  // Astro is a static site generator — its own repo is more deployable than framework
  if (hasAstroConfig && hasPackages) scores.framework -= 3;

  // ── SERVER: backend app ──
  if (hasServerDep) scores.server += 3;
  if (hasServerPaths) scores.server += 2;
  // Penalties
  if (hasLib && hasExamples) scores.server -= 3; // framework structure
  if (hasPackages) scores.server -= 2;
  if (hasPages) scores.server -= 2;

  // ── DEPLOYABLE: runs as a deployed app/site ──
  if (hasNext || hasNextConfig) scores.deployable += 3;
  if (hasNuxt || hasNuxtConfig) scores.deployable += 3;
  if (hasAstro || hasAstroConfig) scores.deployable += 3;
  if (hasPages) scores.deployable += 2;
  if (hasBuild) scores.deployable += 2;
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
    // Fallbacks before unknown
    if (hasPkgJson && hasStart) return RepoType.DEPLOYABLE;
    if (hasPkgJson && hasBuild) return RepoType.LIBRARY;
    if (hasPkgJson) return RepoType.DEPLOYABLE;
    return RepoType.UNKNOWN;
  }

  const winner = entries[0][0];
  return RepoType[winner.toUpperCase()] || RepoType.UNKNOWN;
}
