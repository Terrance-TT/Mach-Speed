// central.js — The orchestrator: fetches repos, runs specialists, compiles reports

import { classifyRepo } from './classifier.js';
import { compileReport } from './report-compiler.js';
import { shouldRun, validateResult } from './contract.js';

// Specialists — import each checker module here
import * as dynamicPort from './specialists/dynamic-port.js';
import * as cors from './specialists/cors.js';
import * as databaseConfig from './specialists/database-config.js';
import * as envVars from './specialists/env-vars.js';
import * as lockfile from './specialists/lockfile.js';
import * as hostBinding from './specialists/host-binding.js';
import * as nodeVersion from './specialists/node-version.js';
import * as startScript from './specialists/start-script.js';
import * as buildStep from './specialists/build-step.js';
import * as staticFiles from './specialists/static-files.js';
import * as healthCheck from './specialists/health-check.js';
import * as secrets from './specialists/secrets.js';

export const SPECIALISTS = [
  dynamicPort,
  cors,
  databaseConfig,
  envVars,
  lockfile,
  hostBinding,
  nodeVersion,
  startScript,
  buildStep,
  staticFiles,
  healthCheck,
  secrets,
];

export async function fetchRepoTree(owner, repo) {
  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  if (!metaRes.ok) throw new Error(`GitHub API error: ${metaRes.status}`);
  const meta = await metaRes.json();
  const branch = meta.default_branch;
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  );
  if (!treeRes.ok) throw new Error(`Tree API error: ${treeRes.status}`);
  const treeData = await treeRes.json();
  return {
    branch,
    tree: treeData.tree.map(item => item.path),
    sha: treeData.sha,
  };
}

export async function fetchFile(owner, repo, branch, path) {
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
  );
  if (!res.ok) return null;
  return res.text();
}

export async function analyzeRepo(owner, repo) {
  const { tree, branch } = await fetchRepoTree(owner, repo);

  let packageJson = null;
  const pkgContent = await fetchFile(owner, repo, branch, 'package.json');
  if (pkgContent) {
    try { packageJson = JSON.parse(pkgContent); } catch { /* ignore */ }
  }

  const repoType = await classifyRepo(tree, packageJson);

  const fileCache = new Map();
  const files = {
    get: async (path) => {
      if (fileCache.has(path)) return fileCache.get(path);
      const content = await fetchFile(owner, repo, branch, path);
      fileCache.set(path, content);
      return content;
    },
    has: (path) => tree.includes(path),
  };

  const context = { tree, files, packageJson, repoType, owner, repo };
  const toRun = SPECIALISTS.filter(s => shouldRun(s.checkId, repoType));

  const results = await Promise.all(
    toRun.map(async (specialist) => {
      try {
        const result = await specialist.check(context);
        const validation = validateResult(result);
        if (!validation.valid) {
          return { checkId: specialist.checkId, status: 'check-it', confidence: 'low', message: `Specialist error: ${validation.error}`, findings: [] };
        }
        return result;
      } catch (err) {
        return { checkId: specialist.checkId, status: 'check-it', confidence: 'low', message: `Specialist crashed: ${err.message}`, findings: [] };
      }
    })
  );

  const scorecard = compileReport(results, repoType, owner, repo);
  return { owner, repo, branch, repoType, scorecard, results };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [owner, repo] = process.argv.slice(2);
  if (!owner || !repo) { console.log('Usage: node central.js <owner> <repo>'); process.exit(1); }
  analyzeRepo(owner, repo).then(r => console.log(JSON.stringify(r.scorecard, null, 2))).catch(err => { console.error(err.message); process.exit(1); });
}
