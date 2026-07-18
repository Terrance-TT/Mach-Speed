export const checkId = 'start-script';
export const name = 'Start Script Present';
export const appliesTo = ['all'];

function isPlaceholderScript(script) {
  return typeof script !== 'string' || script.trim().length <= 3 || script.toLowerCase().includes('todo');
}

function isLibraryFrameworkOrTool(pkg) {
  if (!pkg) return false;

  const name = String(pkg.name || '').toLowerCase();
  const keywords = (pkg.keywords || []).map(k => String(k).toLowerCase());

  if (pkg.bin) return true;
  if (name.startsWith('@types/')) return true;
  if (/^(eslint|babel-plugin|rollup-plugin|vite-plugin|webpack-plugin|jest-|vitest-plugin|drizzle-|prisma|tslint-plugin|postcss-plugin|unplugin)/.test(name)) return true;
  if (/(plugin|loader|preset|middleware|adapter)$/.test(name)) return true;

  const hasFrameworkKw = keywords.some(k => /\bframework\b/.test(k));
  const hasServerKw = keywords.some(k => /\b(server|http|rest|router|middleware|api|microservice|grpc|websocket|tcp|udp)\b/.test(k));
  if (hasFrameworkKw && hasServerKw) return true;

  if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) return true;

  const libToolKw = /\b(library|plugin|tool|cli|compiler|transpiler|bundler|formatter|linter|middleware|module|package|preset|loader|util|utility|sdk|core|platform|adapter|orm|db|database|types|interface|spec|testing)\b/;
  if (keywords.some(k => libToolKw.test(k))) {
    const appKw = /\b(app|application|website|webapp|cms|blog|starter|template|dashboard|deploy|demo|example|sample|homepage|portfolio|store|shop|portal|landing)\b/;
    if (!keywords.some(k => appKw.test(k))) return true;
  }

  const hasMain = !!pkg.main;
  const looksPublished = hasMain && !!(pkg.types || pkg.typings || pkg.publishConfig || (pkg.files && pkg.files.length > 0));
  if (looksPublished && !pkg.scripts?.start) {
    const modKw = /\b(framework|sdk|api-client|client|server|library|module|core|platform|adapter|tool|util|types|orm|db|database)\b/;
    if (keywords.some(k => modKw.test(k))) return true;
    const appKw = /\b(app|application|website|webapp|cms|blog|starter|template|dashboard|deploy|demo|example|sample)\b/;
    if (!keywords.some(k => appKw.test(k))) return true;
  }

  return false;
}

function isAppPackage(pkg) {
  if (!pkg) return false;
  const keywords = (pkg.keywords || []).map(k => String(k).toLowerCase());
  const appKw = /\b(app|application|website|webapp|cms|blog|starter|template|dashboard|deploy|demo|example|sample|homepage|portfolio|store|shop|portal|landing)\b/;
  if (keywords.some(k => appKw.test(k))) return true;

  const name = String(pkg.name || '').toLowerCase();
  if (/(app|web|client|frontend|admin|dashboard|site|portal|www)$/.test(name)) return true;

  return false;
}

function isMonorepo(pkg, tree) {
  if (!pkg && !tree) return false;
  if (pkg?.workspaces) return true;
  if (tree?.some(p => p === 'pnpm-workspace.yaml')) return true;
  const devDeps = pkg?.devDependencies || {};
  const deps = pkg?.dependencies || {};
  const monoTools = ['turbo', 'lerna', 'nx', '@nrwl/workspace', '@nx/workspace'];
  if (monoTools.some(t => t in devDeps || t in deps)) return true;
  if (tree?.some(p => p === 'packages/' || p.startsWith('packages/') || p === 'apps/' || p.startsWith('apps/') || p === 'services/' || p.startsWith('services/'))) return true;
  return false;
}

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  let pkg = packageJson;
  if (!pkg && files && typeof files.get === 'function') {
    try {
      const raw = await files.get('package.json');
      if (raw) pkg = JSON.parse(raw);
    } catch (e) {
      console.error('Error reading package.json via files.get:', e);
    }
  }

  try {
    if (repoType === 'empty' || !tree || tree.length === 0) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Empty repo — no start script needed',
        findings: [],
      };
    }

    if (!pkg) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'No package.json found — start script check not applicable',
        findings: [],
      };
    }

    const scripts = pkg.scripts || {};
    const startKeys = ['start', 'serve', 'start:prod'];
    let activeScript = null;

    for (const key of startKeys) {
      if (key in scripts) {
        activeScript = scripts[key];
        break;
      }
    }

    if (activeScript !== null) {
      if (!isPlaceholderScript(activeScript)) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Start script found: "${activeScript}"`,
          findings: [],
        };
      }
      return {
        checkId,
        status: 'check-it',
        confidence: 'medium',
        message: `Start script may be placeholder: "${activeScript}"`,
        findings: [{ file: 'package.json', issue: 'Start script appears to be a placeholder' }],
      };
    }

    if (isLibraryFrameworkOrTool(pkg)) {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: 'Library, framework, or tool package — start script not required',
        findings: [],
      };
    }

    if (repoType === 'library' || repoType === 'tool') {
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: `${repoType === 'library' ? 'Library' : 'Tool'} — start script not required`,
        findings: [],
      };
    }

    const monorepo = isMonorepo(pkg, tree);

    if (monorepo) {
      if (scripts.dev && typeof scripts.dev === 'string' && !isPlaceholderScript(scripts.dev)) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: `Monorepo start script found: "${scripts.dev}"`,
          findings: [],
        };
      }

      const hasAppsDir = tree.some(p => p.startsWith('apps/'));
      const hasServicesDir = tree.some(p => p.startsWith('services/'));
      const hasPackagesDir = tree.some(p => p.startsWith('packages/'));

      let foundSubStart = false;
      let appLikeCount = 0;
      let libCount = 0;
      let reads = 0;
      const maxReads = 12;

      const dirsToScan = [];
      if (hasAppsDir) dirsToScan.push('apps/');
      if (hasServicesDir) dirsToScan.push('services/');
      if (hasPackagesDir) dirsToScan.push('packages/');

      for (const dir of dirsToScan) {
        const subPkgs = tree.filter(p => p.startsWith(dir) && p.endsWith('/package.json') && p.slice(dir.length).split('/').length === 2);

        for (const subPath of subPkgs) {
          if (reads >= maxReads) break;
          reads++;
          try {
            const content = await files.get(subPath);
            if (!content) continue;
            const sub = JSON.parse(content);
            const subScripts = sub.scripts || {};
            const subStart = subScripts.start || subScripts.serve || subScripts['start:prod'] || subScripts.dev;
            if (typeof subStart === 'string' && !isPlaceholderScript(subStart)) {
              foundSubStart = true;
              break;
            }

            const inAppDir = dir === 'apps/' || dir === 'services/';
            if (isAppPackage(sub)) {
              appLikeCount++;
            } else if (isLibraryFrameworkOrTool(sub)) {
              libCount++;
            } else if (inAppDir) {
              appLikeCount++;
            }
          } catch (e) {
            console.error(`Error reading ${subPath}:`, e);
          }
        }
        if (foundSubStart) break;
      }

      if (foundSubStart) {
        return {
          checkId,
          status: 'pass',
          confidence: 'high',
          message: 'Monorepo — start script found in sub-package',
          findings: [],
        };
      }

      if (appLikeCount > 0) {
        return {
          checkId,
          status: 'fail',
          confidence: 'high',
          message: 'App monorepo — no start script found in root or app sub-packages',
          findings: [{ file: 'package.json', issue: 'Missing start script in app monorepo' }],
        };
      }

      if (libCount > 0 || (hasPackagesDir && !hasAppsDir && !hasServicesDir)) {
        return {
          checkId,
          status: 'not-applicable',
          confidence: 'high',
          message: 'Library/framework/tool monorepo — start script not required',
          findings: [],
        };
      }

      return {
        checkId,
        status: 'not-applicable',
        confidence: 'medium',
        message: 'Monorepo with no deployment start script required',
        findings: [],
      };
    }

    if (tree.includes('Procfile')) {
      return {
        checkId,
        status: 'pass',
        confidence: 'high',
        message: 'Procfile found — deployment entrypoint present',
        findings: [],
      };
    }

    const dockerfile = tree.find(p => p === 'Dockerfile' || p.endsWith('/Dockerfile'));
    if (dockerfile) {
      try {
        const content = await files.get(dockerfile);
        if (content && /^\s*(CMD|ENTRYPOINT)\s/im.test(content)) {
          return {
            checkId,
            status: 'pass',
            confidence: 'high',
            message: 'Dockerfile with CMD/ENTRYPOINT found — deployment entrypoint present',
            findings: [],
          };
        }
      } catch (e) {
        console.error('Error reading Dockerfile:', e);
      }
    }

    return {
      checkId,
      status: 'fail',
      confidence: 'high',
      message: 'No start script found in package.json',
      findings: [{ file: 'package.json', issue: 'Missing "start" script — required for deployment' }],
    };
  } catch (err) {
    console.error('start-script specialist error:', err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error during check: ${err.message}`,
      findings: [],
    };
  }
}