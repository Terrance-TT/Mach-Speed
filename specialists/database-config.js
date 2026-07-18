/**
 * Specialist: database-config
 * Checks if database connection uses environment variables rather than hardcoded credentials.
 */

export const checkId = 'database-config';
export const name = 'Database Configuration';
export const appliesTo = ['deployable', 'server', 'framework'];

const DB_DEPS = [
  'mongoose', 'sequelize', 'prisma', 'typeorm', 'knex', 'pg', 'mysql2', 'mongodb', 'redis', '@prisma/client',
  'drizzle-orm', 'drizzle-kit', '@astrojs/db', 'kysely'
];

// GOOD patterns — evidence that DB config uses env vars
const GOOD_PATTERNS = [
  // JS/TS: process.env.* patterns
  /process\.env\.(DATABASE_URL|DATABASE_HOST|DATABASE_NAME|DATABASE_PORT|DATABASE_USER|DATABASE_PASSWORD|DATABASE_USERNAME)/i,
  /process\.env\.(DB_HOST|DB_NAME|DB_PORT|DB_USER|DB_PASS|DB_PASSWORD|DB_USERNAME|DB_URL|DB_CONNECTION_STRING)/i,
  /process\.env\.(MONGO|MONGODB)_/i,
  /process\.env\.(REDIS|REDIS_URL|REDIS_HOST|REDIS_PORT)/i,
  /process\.env\.(PG_|POSTGRES_|POSTGRESQL_)/i,
  /process\.env\.(MYSQL_|MYSQL2_)/i,
  /process\.env\.[A-Z_]*DATABASE[A-Z_]*/i,
  /process\.env\.[A-Z_]*DB_[A-Z_]+/i,
  // Vite / Astro / Deno env patterns
  /import\.meta\.env\.[A-Z_]*(?:DATABASE|DB|POSTGRES|MONGO|REDIS)[A-Z_]*/i,
  /Deno\.env\.get\s*\(\s*["'][^"']*(?:DATABASE|DB|POSTGRES|MONGO|REDIS)[^"']*["']\s*\)/i,
  // Prisma / JS env() patterns
  /env\s*\(\s*["'][^"']*DATABASE[^"']*["']\s*\)/i,
  /env\s*\(\s*["'][^"']*DB_[^"']*["']\s*\)/i,
  /env\s*\(\s*["'][^"']*(MONGO|REDIS|POSTGRES|MYSQL)[^"']*["']\s*\)/i,
  // Config-from-env patterns (Directus-style)
  /getConfigFromEnv\s*\(\s*['"]DB_/i,
  /getConfigFromEnv\s*\(\s*['"]DATABASE/i,
  // Docker compose env interpolation
  /\$\{(DATABASE_URL|DB_HOST|DB_NAME|DB_PORT|DATABASE_[A-Z_]+)\}/i,
  /\$\{(MONGO|MONGODB|REDIS|POSTGRES|MYSQL)[A-Z_]*\}/i,
  // .env / .env.example files: raw env var assignments
  /^(DATABASE_URL|DATABASE_HOST|DATABASE_NAME|DATABASE_PORT|DATABASE_USER)=/im,
  /^(DB_HOST|DB_NAME|DB_PORT|DB_USER|DB_PASS|DB_URL)=/im,
  /^(MONGO|MONGODB)_/im,
  /^(PG_|POSTGRES_|POSTGRESQL_)/im,
  /^(REDIS_URL|REDIS_HOST|REDIS_PORT)=/im,
];

// BAD patterns — hardcoded connection strings with credentials
const BAD_PATTERNS = [
  /(mongodb|mongodb\+srv|postgres|postgresql|mysql|redis):\/\/[^:]+:[^@\s]+@\S+/i,
];

// STRONG indicators — used when hasDbDep is false
const STRONG_INDICATOR_PATTERNS = [
  /(^|[\/])(db|database|model)s?[\/]/i,
  /(^|[\/])prisma[\/]/i,
  /(^|[\/])drizzle\.config\.(ts|js|mjs|cjs)$/i,
  /(^|[\/])(config|configs)[\/](db|database|mongo|postgres|mysql|redis)/i,
  /(^|[\/])([^\/]*\.)?(db|database|mongo|postgres|mysql|redis)([^\/]*)?\.(js|ts|mjs|cjs)$/i,
];

// WEAK indicators — used only when hasDbDep is true
const WEAK_INDICATOR_PATTERNS = [
  /\.env/i,
  /(docker-compose|compose\.)/i,
  /(^|[\/])connection\.(js|ts|mjs|cjs)$/i,
];

const SCAN_EXTENSIONS = /\.(js|ts|mjs|cjs|prisma|yml|yaml)$/i;
const MAX_READS = 30;

function isDbDriverLibrary(packageJson) {
  const pkgName = packageJson?.name;
  if (!pkgName) return false;
  if (DB_DEPS.includes(pkgName)) return true;
  if (pkgName.startsWith('@')) {
    const scopeName = pkgName.split('/')[1];
    if (scopeName && DB_DEPS.includes(scopeName)) return true;
  }
  return false;
}

function shouldSkipForBadPatterns(filePath) {
  if (/\.env/i.test(filePath)) return true;
  if (/docker-compose|compose\./i.test(filePath)) return true;
  if (/(^|[\/])(test|tests|spec|__tests__|fixtures?|examples?|playground|docs|\.github|scripts|website|www)[\/]/i.test(filePath)) return true;
  return false;
}

function isAppLevelPath(filePath) {
  return !/(^|[\/])(packages|examples|test|tests|spec|__tests__|fixtures?|playground|docs|website|www|scripts|\.github)[\/]/i.test(filePath);
}

export async function check(context) {
  const { tree, files, packageJson } = context;

  try {
    if (tree.length === 0) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'Empty repo — no DB config needed', findings: [] };
    }

    if (isDbDriverLibrary(packageJson)) {
      const reason = packageJson?.name || 'unknown';
      return { checkId, status: 'not-applicable', confidence: 'high', message: `DB driver library (${reason}) — not applicable`, findings: [] };
    }

    const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies } || {};
    let hasDbDep = DB_DEPS.some(d => deps[d]);

    // Scan workspace package.json files for monorepo DB deps
    if (!hasDbDep) {
      const pkgJsonPaths = tree
        .filter(p => /(^|[\/])package\.json$/.test(p) && !/(^|[\/])(node_modules|\.git|dist|build|test|tests|examples?|__tests__|fixtures)[\/]/i.test(p))
        .slice(0, 20);
      for (const p of pkgJsonPaths) {
        const content = await files.get(p);
        if (content) {
          try {
            const parsed = JSON.parse(content);
            const subDeps = { ...parsed?.dependencies, ...parsed?.devDependencies };
            if (DB_DEPS.some(d => subDeps[d])) {
              hasDbDep = true;
              break;
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    }

    if (!hasDbDep) {
      const strongMatches = tree.filter(p => {
        if (!SCAN_EXTENSIONS.test(p)) return false;
        if (/(node_modules|\.git|dist|build)/i.test(p)) return false;
        return STRONG_INDICATOR_PATTERNS.some(pat => pat.test(p));
      });
      if (strongMatches.length === 0) {
        return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No database dependency or DB-related files found', findings: [] };
      }
    }

    // Build prioritized scan list
    const candidates = [];
    const seen = new Set();

    function add(fileList, score) {
      for (const f of fileList) {
        if (seen.has(f)) continue;
        seen.add(f);
        candidates.push({ file: f, score });
      }
    }

    // High priority: named config files
    add(tree.filter(p => 
      /(^|[\/])(config[\/])?(database|db)\.(js|ts|mjs|cjs)$/i.test(p) &&
      !/(node_modules|\.git|dist|build)/i.test(p)
    ), 100);

    add(tree.filter(p => 
      /drizzle\.config\.(ts|js|mjs|cjs)$/i.test(p) &&
      !/(node_modules|\.git|dist|build)/i.test(p)
    ), 100);

    add(tree.filter(p => 
      /(^|[\/])prisma[\/][^\/]+\.prisma$/i.test(p) &&
      !/(node_modules|\.git|dist|build)/i.test(p)
    ), 95);

    // Env files: prioritize root-level (fewest path segments)
    const envList = tree.filter(p => 
      /\.env/i.test(p) && 
      !/(node_modules|\.git|dist|build)/i.test(p) &&
      !/\.(test|spec|fixture|mock)\.env/i.test(p)
    ).sort((a, b) => a.split('/').length - b.split('/').length);
    add(envList.slice(0, 5), 90);

    // Docker compose
    add(tree.filter(p => 
      /docker-compose|compose\./i.test(p) && 
      /\.(yml|yaml)$/i.test(p) &&
      !/(node_modules|\.git|dist|build)/i.test(p)
    ), 80);

    // Other DB-related source files, sorted by depth (root first)
    const other = tree.filter(p => {
      if (!/\.(js|ts|mjs|cjs)$/i.test(p)) return false;
      if (/(node_modules|\.git|dist|build)/i.test(p)) return false;
      return [...STRONG_INDICATOR_PATTERNS, ...WEAK_INDICATOR_PATTERNS].some(pat => pat.test(p));
    }).sort((a, b) => a.split('/').length - b.split('/').length);
    add(other.slice(0, 15), 70);

    const sourceFiles = candidates.slice(0, MAX_READS).map(c => c.file);

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
              findings.push({ file: filePath, line: i + 1, issue: 'DB config uses environment variables' });
              break;
            }
          }
        }
      }

      // Check for BAD patterns (hardcoded credentials) only in relevant source files
      if (!shouldSkipForBadPatterns(filePath)) {
        for (const pattern of BAD_PATTERNS) {
          const matches = content.match(new RegExp(pattern.source, 'gmi'));
          if (matches) {
            foundBad = true;
            const lines = content.split('\n');
            for (const matchStr of matches.slice(0, 3)) {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(matchStr.substring(0, 40))) {
                  findings.push({ file: filePath, line: i + 1, issue: 'Hardcoded DB connection string with credentials' });
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

    // No definitive patterns found
    if (!hasDbDep) {
      return { checkId, status: 'not-applicable', confidence: 'medium', message: 'No database dependency or DB-related files found', findings: [] };
    }

    const hasAppLevelFile = sourceFiles.some(isAppLevelPath);
    if (!hasAppLevelFile) {
      return { checkId, status: 'not-applicable', confidence: 'medium', message: 'DB-related code appears to be library or example-only', findings: [] };
    }

    const scannedFindings = sourceFiles.slice(0, 3).map(file => ({
      file,
      issue: 'Scanned for DB config patterns but none were recognized'
    }));
    return { checkId, status: 'check-it', confidence: 'medium', message: 'DB dependency found but could not verify env-based configuration in scanned files', findings: scannedFindings };

  } catch (err) {
    console.error(`[database-config] error:`, err);
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [] };
  }
}