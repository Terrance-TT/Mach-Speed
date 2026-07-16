// specialists/health-check.js — Checks for health check endpoint
//
// Strategy: Trust repoType from the classifier. Only skip LIBRARY and EMPTY.
// For all other types, scan route/server files for health endpoint patterns.

import { RepoType } from '../contract.js';

export const checkId = 'health-check';
export const name = 'Health Check Route';
export const appliesTo = ['deployable', 'server', 'framework'];

// Patterns that match health endpoint definitions in code
const HEALTH_PATTERNS = [
  /['"\/]health['"\/]/i,         // '/health', "/health", `/health`
  /['"\/]healthz['"\/]/i,        // '/healthz' (k8s convention)
  /['"\/]healthcheck['"\/]/i,    // '/healthcheck' (one word)
  /['"\/]health-check['"\/]/i,   // '/health-check' (hyphenated)
  /['"\/]ready['"\/]/i,          // '/ready' (k8s readiness)
  /['"\/]alive['"\/]/i,          // '/alive' (liveness)
  /['"\/]status['"\/]/i,         // '/status'
];

// Filename keywords that suggest a file contains route definitions
const ROUTE_DIR_PATTERNS = [
  { re: /(^|\/)routes?\//i, score: 8 },
  { re: /(^|\/)api\//i, score: 7 },
  { re: /(^|\/)pages\//i, score: 6 },
  { re: /(^|\/)controllers?\//i, score: 5 },
  { re: /(^|\/)handlers?\//i, score: 4 },
  { re: /(^|\/)middleware\//i, score: 4 },
  { re: /(^|\/)server\//i, score: 4 },
  { re: /(^|\/)backend\//i, score: 3 },
];

const ROUTE_FILE_PATTERNS = [
  { re: /^(server|app|index|main)\.(js|ts|mjs|cjs)$/, score: 10 },
  { re: /(^|\/)(route|router|server|app|api)[^a-z]/i, score: 3 },
  { re: /(^|\/)(controller|handler|endpoint)[^a-z]/i, score: 2 },
  { re: /(^|\/)(middleware|status|check)[^a-z]/i, score: 2 },
];

// Penalize these directories/patterns
const PENALTY_PATTERNS = [
  { re: /(^|\/)(example|demo|playground|fixture|benchmark|test|spec|\.d\.ts)/i, score: -5 },
  { re: /(^|\/)(\.github|\.storybook|scripts|dist|build|coverage|storybook|bin|cli|config|vitest|jest|knip|lint)/i, score: -4 },
];

/**
 * Scores a file path by how likely it is to contain a health endpoint.
 * Higher score = more likely. Files with score <= 0 are skipped.
 */
function scoreRouteFile(path) {
  let score = 0;
  const lower = path.toLowerCase();
  const basename = path.split('/').pop().toLowerCase();

  // TIER 1: Files with "health" in the name — highest priority
  if (basename.includes('health')) score += 20;

  // TIER 2: Root-level server entry points
  for (const { re, score: s } of ROUTE_FILE_PATTERNS) {
    if (re.test(path)) score += s;
  }

  // TIER 3: Common route directories
  for (const { re, score: s } of ROUTE_DIR_PATTERNS) {
    if (re.test(lower)) score += s;
  }

  // TIER 4: src/ directory files get a small boost
  if (path.startsWith('src/')) score += 1;

  // PENALTIES
  for (const { re, score: s } of PENALTY_PATTERNS) {
    if (re.test(lower)) score += s;
  }
  const depth = path.split('/').length;
  if (depth > 5) score -= 2;

  return score;
}

export async function check(context) {
  const { tree, files, repoType } = context;

  try {
    // STEP 1: Trust the classifier — only skip LIBRARY and EMPTY repos
    if (repoType === RepoType.LIBRARY || repoType === RepoType.EMPTY) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Library or empty repo — no health route needed',
        findings: [],
      };
    }

    // STEP 2: Select the most likely files to contain health routes
    const candidates = tree
      .filter(p =>
        /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(p) &&
        !/(test|spec|__tests__|__mocks__)/i.test(p) &&
        !/\.d\.ts$/.test(p)
      )
      .map(p => ({ path: p, score: scoreRouteFile(p) }))
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score);

    const routeFiles = candidates.slice(0, 5).map(f => f.path);

    // Fallback: if no scored files, try top-level JS/TS files
    if (routeFiles.length === 0) {
      const fallback = tree
        .filter(p =>
          /^(src\/)?[^/]+\.(js|ts|mjs|cjs)$/.test(p) &&
          !/(test|spec|\.d\.ts)/i.test(p)
        )
        .slice(0, 3);
      routeFiles.push(...fallback);
    }

    // STEP 3: Scan selected files for health patterns
    for (const filePath of routeFiles) {
      const content = await files.get(filePath);
      if (!content) continue;

      for (const pattern of HEALTH_PATTERNS) {
        if (pattern.test(content)) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: `Health check route found in ${filePath}`,
            findings: [{ file: filePath, issue: 'Health endpoint detected' }],
          };
        }
      }
    }

    // Nothing found after scanning the best candidates
    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'No health check route detected',
      findings: [],
    };

  } catch (err) {
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error: ${err.message}`,
      findings: [],
    };
  }
}
