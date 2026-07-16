/**
 * Specialist: database-config
 * Checks if database connection uses environment variables rather than hardcoded credentials.
 */

import { RepoType } from '../contract.js';

export const checkId = 'database-config';
export const name = 'Database Configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

const DB_DEPS = ['mongoose', 'sequelize', 'prisma', 'typeorm', 'knex', 'pg', 'mysql2', 'mongodb', 'redis', '@prisma/client'];

// GOOD patterns — evidence that DB config uses env vars
const GOOD_PATTERNS = [
  // JS/TS: process.env.* patterns
  /process\.env\.(DATABASE_URL|DATABASE_HOST|DATABASE_NAME|DATABASE_PORT|DATABASE_USER|DATABASE_PASSWORD|DATABASE_USERNAME)/i,
  /process\.env\.(DB_HOST|DB_NAME|DB_PORT|DB_USER|DB_PASS|DB_PASSWORD|DB_USERNAME|DB_URL|DB_CONNECTION_STRING)/i,
  /process\.env\.(MONGO|MONGODB)_/i,
  /process\.env\.(REDIS|REDIS_URL|REDIS_HOST|REDIS_PORT)/i,
  /process\.env\.(PG_|POSTGRES_|POSTGRESQL_)/i,
  /process\.env\.(MYSQL_|MYSQL2_)/i,
  /process\.env\.[A-Z_]*DATABASE[A-Z_]*/i,        // catches NEXT_PRIVATE_DATABASE_URL, etc.
  /process\.env\.[A-Z_]*DB_[A-Z_]+/i,              // catches any DB_ prefixed env var
  // Prisma: env("...") patterns in .prisma files
  /env\s*\(\s*["'][^"']*DATABASE[^"']*["']\s*\)/i,
  /env\s*\(\s*["'][^"']*DB_[^"']*["']\s*\)/i,
  /env\s*\(\s*["'][^"']*(MONGO|REDIS|POSTGRES|MYSQL)[^"']*["']\s*\)/i,
  // Config-from-env patterns (Directus-style)
  /getConfigFromEnv\s*\(\s*['"]DB_/i,
  /getConfigFromEnv\s*\(\s*['"]DATABASE/i,
  // Docker compose env interpolation
  /\$\{(DATABASE_URL|DB_HOST|DB_NAME|DB_PORT|DATABASE_[A-Z_]+)\}/i,
  /\$\{(MONGO|MONGODB|REDIS|POSTGRES|MYSQL)[A-Z_]*\}/i,
  // .env / .env.example files: raw env var assignments (no process.env. prefix)
  /^(DATABASE_URL|DATABASE_HOST|DATABASE_NAME|DATABASE_PORT|DATABASE_USER)=/im,
  /^(DB_HOST|DB_NAME|DB_PORT|DB_USER|DB_PASS|DB_URL)=/im,
  /^(MONGO|MONGODB)_/im,
  /^(PG_|POSTGRES_|POSTGRESQL_)/im,
  /^(REDIS_URL|REDIS_HOST|REDIS_PORT)=/im,
];

// BAD patterns — hardcoded connection strings with credentials
const BAD_PATTERNS = [
  // Connection strings with embedded passwords
  /(mongodb|mongodb\+srv|postgres|postgresql|mysql):\/\/[^:]+:[^@\s]+@\S+/i,
  // MySQL connection strings with password
  /mysql:\/\/\w+:\w+@\w+/i,
];

// STRONG indicators — used when hasDbDep is false
// These are directory-based patterns that strongly indicate DB usage
const STRONG_INDICATOR_PATTERNS = [
  /(^|[\/])(db|database|model)s?[\/]/i,               // files in db/, database/, model/, models/ dirs
  /(^|[\/])prisma[\/]/i,                               // files in prisma/ directory
  /(^|[\/])(config|configs)[\/](db|database|mongo|postgres|mysql|redis)/i,  // config/db/ or config/database/
  /(^|[\/])([^\/]*\.)?(db|database|mongo|postgres|mysql|redis)([^\/]*)?\.(js|ts|mjs|cjs)$/i,  // filenames with DB term
];

// WEAK indicators — used only when hasDbDep is true
// These match too many non-DB repos to be reliable standalone indicators
const WEAK_INDICATOR_PATTERNS = [
  /\.env/i,                                             // .env files (almost every repo has these)
  /(docker-compose|compose\.)/i,                        // docker compose files
  /(^|[\/])connection\.(js|ts|mjs|cjs)$/i,             // connection.js (could be WebSocket, HTTP, etc.)
];

// File extensions we care about
const SCAN_EXTENSIONS = /\.(js|ts|mjs|cjs|prisma|yml|yaml)$/i;
const ENV_EXTENSIONS = /\.env/;
const DOCKER_COMPOSE_PATTERN = /docker-compose/;

// Known DB driver repos that should be skipped
const KNOWN_DB_DRIVER_REPOS = [
  'node-redis', 'redis',
  'node-postgres', 'postgres',
  'node-mysql2', 'mysql2', 'mysql',
  'mongoose',
  'sequelize',
  'prisma',
  'typeorm',
  'knex',
  'mongodb', 'node-mongodb-native',
];

// Detect if this repo IS a DB driver library itself
function isDbDriverLibrary(packageJson, repo) {
  const pkgName = packageJson?.name;
  if (pkgName) {
    if (DB_DEPS.includes(pkgName)) return true;
    if (pkgName.startsWith('@')) {
      const scopeName = pkgName.split('/')[1];
      if (scopeName && DB_DEPS.includes(scopeName)) return true;
    }
  }
  if (repo && KNOWN_DB_DRIVER_REPOS.some(name => repo.toLowerCase() === name.toLowerCase())) return true;
  return false;
}

export async function check(context) {
  const { tree, files, packageJson, repoType, repo } = context;

  try {
    // Skip empty repos and libraries
    if (repoType === RepoType.EMPTY) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Empty repo — no DB config needed', findings: [] };
    }
    if (repoType === RepoType.LIBRARY) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Library — no DB config needed', findings: [] };
    }

    // Skip DB driver libraries themselves
    if (isDbDriverLibrary(packageJson, repo)) {
      const reason = packageJson?.name || repo;
      return { checkId, status: 'not-applicable', confidence: 'high', message: `DB driver library (${reason}) — not applicable`, findings: [] };
    }

    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies } || {};
    const hasDbDep = DB_DEPS.some(d => deps[d]);

    if (!hasDbDep) {
      // When no DB dep: only strong indicators should trigger a scan
      // Weak indicators (.env, docker-compose) are ignored — they match too many repos
      const strongMatches = tree.filter(p => {
        if (!SCAN_EXTENSIONS.test(p)) return false;
        if (/(test|spec|example|node_modules)/.test(p)) return false;
        return STRONG_INDICATOR_PATTERNS.some(pat => pat.test(p));
      });

      if (strongMatches.length === 0) {
        return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No database dependency or DB-related files found', findings: [] };
      }
    }

    // Build prioritized scan list
    // 1. All .env files (small, fast, high signal)
    const envFiles = tree.filter(p => {
      if (!ENV_EXTENSIONS.test(p)) return false;
      if (/\.(test|spec|fixture|mock)\.env/i.test(p)) return false;
      if (/\.db\.env$/i.test(p)) return false;
      return true;
    });

    // 2. All prisma schema files (high signal)
    const prismaFiles = tree.filter(p =>
      /(^|[\/])prisma[\/]/i.test(p) && SCAN_EXTENSIONS.test(p)
    );

    // 3. Docker compose files
    const dockerFiles = tree.filter(p =>
      DOCKER_COMPOSE_PATTERN.test(p) && /\.(yml|yaml)$/.test(p)
    );

    // 4. Other DB-related files (limited)
    const scannedSet = new Set([...envFiles, ...prismaFiles, ...dockerFiles]);
    const otherFiles = tree.filter(p => {
      if (scannedSet.has(p)) return false;
      if (/(test|spec|example|node_modules|\.git)/i.test(p)) return false;
      if (!SCAN_EXTENSIONS.test(p)) return false;
      return [...STRONG_INDICATOR_PATTERNS, ...WEAK_INDICATOR_PATTERNS]
        .some(pat => pat.test(p));
    }).slice(0, 10);

    const sourceFiles = [...envFiles, ...prismaFiles, ...dockerFiles, ...otherFiles]
      .slice(0, 20);

    let foundGood = false;
    let foundBad = false;
    const findings = [];

    for (const filePath of sourceFiles) {
      const content = await files.get(filePath);
      if (!content) continue;

      // Check for GOOD patterns (env vars)
      for (const pattern of GOOD_PATTERNS) {
        if (pattern.test(content)) {
          foundGood = true;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              findings.push({
                file: filePath,
                line: i + 1,
                issue: 'DB config uses environment variables',
                severity: 'info',
              });
              break;
            }
          }
        }
      }

      // Check for BAD patterns (hardcoded credentials)
      // Skip .env.* templates and docker-compose (dev defaults, not production secrets)
      const isEnvTemplate = /\.env\./i.test(filePath);
      const isDockerCompose = /docker-compose|compose\./i.test(filePath);
      if (!isEnvTemplate && !isDockerCompose) {
        for (const pattern of BAD_PATTERNS) {
          const matches = content.match(new RegExp(pattern.source, 'gmi'));
          if (matches) {
            foundBad = true;
            const lines = content.split('\n');
            for (const matchStr of matches.slice(0, 3)) {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(matchStr.substring(0, 40))) {
                  findings.push({
                    file: filePath,
                    line: i + 1,
                    issue: 'Hardcoded DB connection string with credentials',
                    severity: 'critical',
                  });
                  break;
                }
              }
            }
          }
        }
      }
    }

    // Decision logic
    if (foundGood && !foundBad) {
      return { checkId, status: 'pass', confidence: 'high', message: 'DB configured with environment variables', findings };
    }
    if (foundBad && !foundGood) {
      return { checkId, status: 'fail', confidence: 'high', message: 'Hardcoded DB credentials detected', findings };
    }
    if (foundBad && foundGood) {
      return { checkId, status: 'fail', confidence: 'high', message: 'Hardcoded DB credentials detected alongside some env var usage', findings };
    }
    if (hasDbDep) {
      return { checkId, status: 'check-it', confidence: 'medium', message: 'DB dependency found but could not verify config (no recognized patterns)', findings: [] };
    }
    return { checkId, status: 'check-it', confidence: 'low', message: 'Could not determine DB configuration', findings: [] };

  } catch (err) {
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [] };
  }
}
