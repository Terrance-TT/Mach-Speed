// specialists/static-files.js — Checks if the app has static file serving configured

import { RepoType } from '../contract.js';

export const checkId = 'static-files';
export const name = 'Static Files Served';
export const appliesTo = ['deployable', 'server'];

// Popular static file serving libraries — used for dependency detection
const STATIC_SERVING_DEPS = [
  'serve-static',
  'express-static',
  'serve-handler',
  'sirv',
  'http-server',
  'live-server',
  'koa-static',
  'fastify-static',
  '@fastify/static',
  'hono-static',
  'connect-static',
];

// Frameworks that automatically serve public/ and static/ directories
// without requiring explicit static file serving configuration
const FRAMEWORKS_WITH_BUILTIN_STATIC = [
  'next',           // Next.js — serves public/ automatically
  'astro',          // Astro — serves public/ automatically
  'nuxt',           // Nuxt — serves public/ and static/ automatically
  '@sveltejs/kit',  // SvelteKit — serves static/ automatically
  'gatsby',         // Gatsby — serves static/ automatically
  'vite',           // Vite — serves public/ in dev and build
  '@remix-run/react', // Remix — serves public/ automatically
  'react-scripts',  // Create React App — serves public/ automatically
  '@vue/cli-service', // Vue CLI — serves public/ automatically
];

// Patterns that definitively indicate static file serving configuration
// These match actual serving setup, not arbitrary string literals
const STATIC_PATTERNS = [
  /express\.static\s*\(/,              // express.static() call
  /serve-static/,                       // serve-static import/require
  /serve-handler/,                      // serve-handler import (used by vercel/serve)
  /sirv\s*\(/,                          // sirv() call
  /sirv[^/]*static/i,                   // sirv-static, sirv with static context
  /koa-static/,                         // koa-static import
  /fastify-static/,                     // fastify-static import
  /['"]\/public['"]/,                  // mount point '/public'
  /['"]\/static['"]/,                   // mount point '/static'
  /vite\s+preview/,                     // vite preview command
  /serve\s+-s/,                         // serve -s (SPA mode)
];

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    // Skip repo types where static file serving is not relevant
    // Note: FRAMEWORK is already filtered out by appliesTo + shouldRun()
    if (repoType === RepoType.LIBRARY || repoType === RepoType.EMPTY) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Static file serving not applicable', findings: [] };
    }

    // Check package.json for static serving dependencies
    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies } || {};
    const hasStaticDep = STATIC_SERVING_DEPS.some(dep => deps[dep]);
    if (hasStaticDep) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Static file serving dependency found', findings: [] };
    }

    // Check package.json scripts for static serving commands
    const scripts = packageJson?.scripts || {};
    const allScriptText = Object.values(scripts).join(' ');
    if (/serve\s+(?:-s|--single|\.)|http-server|live-server/.test(allScriptText)) {
      return { checkId, status: 'pass', confidence: 'high', message: 'Static file serving found in package.json scripts', findings: [] };
    }

    // Modern frameworks (Next.js, Astro, Nuxt, etc.) automatically serve
    // files from public/ and static/ directories without explicit config.
    // If such a framework is a dependency AND a public/static dir exists,
    // the framework handles static serving — this is a pass.
    const usesFrameworkWithBuiltinStatic = FRAMEWORKS_WITH_BUILTIN_STATIC.some(dep => deps[dep]);
    const hasPublicDir = tree.some(p => p.includes('/public/') || p.startsWith('public/'));
    const hasStaticDir = tree.some(p => p.includes('/static/') || p.startsWith('static/'));
    if (usesFrameworkWithBuiltinStatic && (hasPublicDir || hasStaticDir)) {
      return { checkId, status: 'pass', confidence: 'high', message: `Framework serves ${hasPublicDir ? 'public/' : 'static/'} automatically`, findings: [] };
    }

    // Scan relevant source files for static file serving patterns
    // Include middleware/route/static/config files (not just server/app/index)
    // Uses basename-only matching with word boundaries to avoid substring
    // false positives (e.g., 'app' matching inside 'apps', 'route' inside
    // 'active-route'). Also excludes non-source directories (.github, e2e).
    // Results are sorted so 'static' and 'middleware' files are checked first.
    const allMatches = tree.filter(p => {
      const basename = p.split('/').pop() || p;
      return (
        /\.(js|ts|mjs|cjs)$/.test(p) &&
        !/(test|spec|example|\.d\.ts)/i.test(p) &&
        !p.startsWith('.github/') &&
        !p.startsWith('e2e/') &&
        !p.startsWith('test/') &&
        !p.startsWith('docs/') &&
        /\b(server|app|index|middleware|route|static|config)\b/i.test(basename)
      );
    });

    // Sort: prioritize files most likely to contain static serving config
    const priority = /\b(static|middleware|server)\b/i;
    const serverFiles = allMatches
      .sort((a, b) => {
        const aPrio = priority.test(a.split('/').pop()) ? 1 : 0;
        const bPrio = priority.test(b.split('/').pop()) ? 1 : 0;
        return bPrio - aPrio;
      })
      .slice(0, 10);

    for (const filePath of serverFiles) {
      const content = await files.get(filePath);
      if (!content) continue;
      for (const pattern of STATIC_PATTERNS) {
        if (pattern.test(content)) {
          return { checkId, status: 'pass', confidence: 'high', message: `Static file serving in ${filePath}`, findings: [{ file: filePath, issue: 'Static file serving detected' }] };
        }
      }
    }

    // Fallback: public/ or static/ directories exist but no framework or
    // explicit serving config was detected — flag for manual review
    if (hasPublicDir || hasStaticDir) {
      return { checkId, status: 'check-it', confidence: 'medium', message: `Static directory found but no explicit serving config`, findings: [] };
    }

    return { checkId, status: 'check-it', confidence: 'medium', message: 'No static file serving configuration detected', findings: [] };

  } catch (err) {
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [] };
  }
}
