#!/usr/bin/env node
// auto-fix.js — closes the self-heal loop: sends specialist evidence to the Moonshot API,
// validates the returned rewrite, and opens one PR per fixed specialist.
//
// Usage:
//   node auto-fix.js --evidence ./evidence [--dry-run] [--only cors,dynamic-port]
//                    [--out ./proposed] [--pr] [--max-fixes 8] [--retries 1]
//
// What it does (per flagged specialist):
//   1. Reads evidence/<checkId>.md + the current specialists/<checkId>.js
//   2. Sends both (plus the specialist contract/ground rules) to Moonshot (kimi-k2)
//      as a PERSISTENT thread — one conversation per specialist, kept on the
//      `auto-fix-state` branch (threads/<checkId>.json), like the manual Kimi chats
//   3. Extracts the returned module, then validates: contract exports present,
//      `node --check` passes, test-harness.js passes
//   4. Valid  -> proposed/<checkId>.js (locally) or a PR branch auto-fix/<checkId> (--pr)
//      Invalid -> one retry with the failure fed back into the thread
//
// Safety rails:
//   - REFUSES to run on INCOMPLETE evidence (report.json incomplete:true)
//   - Never pushes to main — only auto-fix/* branches + pull requests
//   - Model selection: auto-discovers the account's models (GET /v1/models) and
//     picks the best kimi model; falls back to a built-in list if discovery fails
//   - Preflight: one tiny inference call before starting; exits with clear
//     guidance (code 3) if the key lacks inference permission
//   - Streaming: completions use SSE so multi-minute generations can't die on
//     idle connection timeouts; 12-minute hard cap per call
//   - Rate limits (429): waits out the per-minute window instead of hammering,
//     and aborts the run early if the account stays throttled (trial tiers!)
//
// Env:
//   MOONSHOT_API_KEY   (required, except --dry-run)
//   MOONSHOT_BASE_URL  default https://api.moonshot.ai/v1  (China: https://api.moonshot.cn/v1)
//   MOONSHOT_MODEL     optional override (auto-detected from your account when unset or unavailable)
//   GITHUB_TOKEN       (required for --pr and remote threads; Actions provides it)
//   GITHUB_REPOSITORY  owner/repo (Actions provides it; or use --repo owner/name)

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { installFetchMiddleware } from './auto-heal.js';
import { pool } from './repo-cache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Config ──
const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const MODEL_CANDIDATES = ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'kimi-latest'];
const TEMPERATURE = 1; // the current Kimi catalog rejects anything else ("only 1 is allowed for this model")
const MAX_THREAD_MESSAGES = 2;     // prior exchanges kept per specialist (bounds token cost)
const CALL_SPACING_MS = 1_500;     // polite spacing between Moonshot calls
const CALL_TIMEOUT_MS = 12 * 60_000; // hard cap per completion call (streaming makes this generous)
const FIX_CONCURRENCY = 3;         // specialists fixed in parallel (429-handler paces the account)
export const STATE_BRANCH = 'auto-fix-state';

// Read an OpenAI-style SSE stream (data: {...}\n\n ... data: [DONE]) and
// accumulate the assistant content + final usage (if the provider sends it).
export async function readSseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '', usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') content += delta;
        if (j?.usage) usage = j.usage;
      } catch { /* split JSON line — the next chunk completes it */ }
    }
  }
  return { content, usage };
}

// ── CLI parsing ──
function parseArgs(argv) {
  const opt = { evidence: './evidence', out: './proposed', pr: false, dryRun: false, maxFixes: 8, retries: 1, only: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--evidence') opt.evidence = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--pr') opt.pr = true;
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--max-fixes') opt.maxFixes = Number(argv[++i]);
    else if (a === '--retries') opt.retries = Number(argv[++i]);
    else if (a === '--only') opt.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--repo') opt.repo = argv[++i];
  }
  return opt;
}

// ── Moonshot API ──
export class Moonshot {
  constructor() {
    this.apiKey = process.env.MOONSHOT_API_KEY || null;
    this.baseUrl = (process.env.MOONSHOT_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = null; // resolved on first call
    this.usage = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  }

  candidates() {
    const configured = process.env.MOONSHOT_MODEL ? [process.env.MOONSHOT_MODEL] : [];
    return [...new Set([...configured, ...MODEL_CANDIDATES])];
  }

  // Masked key for logs — enough to tell keys apart, safe to print.
  fingerprint() {
    if (!this.apiKey) return '(none)';
    const k = this.apiKey.trim();
    return k.length > 10 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '(too short to show)';
  }

  // Ask the account which models it actually has, instead of guessing names.
  async discoverModels() {
    if (this._discovered !== undefined) return this._discovered;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const ids = (Array.isArray(data?.data) ? data.data : []).map((m) => m && m.id).filter(Boolean);
      this._discovered = ids.length ? ids : null;
    } catch (err) {
      console.warn(`    [moonshot] model discovery failed (${err.message}) — falling back to built-in candidate list`);
      this._discovered = null;
    }
    return this._discovered;
  }

  // Resolve once, on first use: prefer the configured model if the account has
  // it, otherwise the best available kimi model. Returns null if discovery
  // failed — chat() then walks the candidate chain as before.
  async resolveModel() {
    if (this.model) return this.model;
    const available = await this.discoverModels();
    if (available) {
      console.log(`    [moonshot] models on this account: ${available.join(', ')}`);
      const configured = process.env.MOONSHOT_MODEL;
      const pick = this.candidates().find((m) => available.includes(m))
        || available.find((id) => /kimi/i.test(id))
        || available[0];
      if (configured && configured !== pick) {
        console.warn(`    [moonshot] configured model '${configured}' is not available on this account — using '${pick}'`);
      } else {
        console.log(`    [moonshot] model resolved: ${pick}`);
      }
      this.model = pick;
      this._modelConfirmed = true; // came from the account's own /models list
    }
    return this.model;
  }

  // Moonshot runs TWO separate platforms: api.moonshot.ai (international) and
  // api.moonshot.cn (China). A key from one can authenticate and list models on
  // the other but cannot run inference there — the classic "listed but denied"
  // symptom. If that happens, probe the other region and switch if it works.
  async tryAlternateRegion() {
    const alt = this.baseUrl.includes('moonshot.cn') ? 'https://api.moonshot.ai/v1' : 'https://api.moonshot.cn/v1';
    try {
      const listRes = await fetch(`${alt}/models`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      if (!listRes.ok) return false;
      const data = await listRes.json();
      const ids = (Array.isArray(data?.data) ? data.data : []).map((m) => m && m.id).filter(Boolean);
      const pick = this.candidates().find((m) => ids.includes(m)) || ids.find((id) => /kimi/i.test(id)) || ids[0];
      if (!pick) return false;
      const res = await fetch(`${alt}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: pick, messages: [{ role: 'user', content: 'ok' }], temperature: TEMPERATURE }),
      });
      if (!res.ok) return false;
      console.warn(`    [moonshot] key works on ${alt} — auto-switching region (set the MOONSHOT_BASE_URL secret to ${alt} to make this permanent)`);
      this.baseUrl = alt;
      this._discovered = ids;
      this.model = pick;
      this._modelConfirmed = true;
      return true;
    } catch {
      return false;
    }
  }

  async chat(messages, { maxRetries = 4 } = {}) {
    if (!this.apiKey) throw new Error('MOONSHOT_API_KEY is not set');
    await this.resolveModel();
    const models = this.model
      ? [this.model, ...this.candidates().filter((m) => m !== this.model)]
      : this.candidates();
    let lastErr = null;

    for (const model of models) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        let res;
        // Streaming keeps the connection warm while the model thinks — a silent
        // multi-minute generation gets killed by idle timeouts ("fetch failed"),
        // which is exactly what happened with non-streaming big-prompt calls.
        const controller = new AbortController();
        const hardCap = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
        try {
          res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify({ model, messages, temperature: TEMPERATURE, stream: true }),
            signal: controller.signal,
          });
        } catch (err) {
          clearTimeout(hardCap);
          lastErr = err.name === 'AbortError' ? new Error(`Moonshot call exceeded the ${Math.round(CALL_TIMEOUT_MS / 60000)}-minute cap`) : err;
          console.warn(`    [moonshot] network error (${lastErr.message}); retry ${attempt}/${maxRetries}`);
          await sleep(2000 * attempt);
          continue;
        }

        if (res.ok) {
          let content = '', usage = null;
          try {
            ({ content, usage } = await readSseStream(res));
          } catch (err) {
            clearTimeout(hardCap);
            lastErr = err.name === 'AbortError' ? new Error(`Moonshot stream exceeded the ${Math.round(CALL_TIMEOUT_MS / 60000)}-minute cap`) : err;
            console.warn(`    [moonshot] stream dropped (${lastErr.message}); retry ${attempt}/${maxRetries}`);
            await sleep(2000 * attempt);
            continue;
          }
          clearTimeout(hardCap);
          if (typeof content !== 'string' || !content.trim()) {
            lastErr = new Error('Moonshot returned an empty completion');
            break; // no point retrying same model immediately
          }
          if (!this.model) {
            this.model = model;
            console.log(`    [moonshot] model resolved: ${model}`);
          }
          if (usage) {
            this.usage.prompt_tokens += usage.prompt_tokens || 0;
            this.usage.completion_tokens += usage.completion_tokens || 0;
          }
          this.usage.calls++;
          return content;
        }
        clearTimeout(hardCap);

        const body = await res.text().catch(() => '');
        // Genuine "model not found / no access" errors -> try the next candidate.
        // Match Moonshot's exact wording — a loose /model/i test would also catch
        // unrelated 400s like "invalid temperature ... for this model" and chain
        // pointlessly through every candidate.
        const modelNotFound = (res.status === 400 || res.status === 404)
          && /not found the model|permission denied|resource_not_found/i.test(body);
        if (modelNotFound) {
          // If this model came from the account's OWN /models list, "not found" is
          // implausible — it's a permission problem. Permission is account-wide:
          // trying other candidates is pointless, fail fast.
          if (this._modelConfirmed && model === this.model) {
            const fatal = new Error(`Moonshot refuses to run '${model}' even though the account itself listed it (HTTP ${res.status}): ${body.slice(0, 200)}`);
            fatal.fatalPermission = true;
            throw fatal;
          }
          console.warn(`    [moonshot] model "${model}" not available (${res.status}): ${body.slice(0, 120)}`);
          lastErr = new Error(`model ${model}: HTTP ${res.status} ${body.slice(0, 160)}`);
          break;
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Moonshot auth failed (HTTP ${res.status}) — check MOONSHOT_API_KEY. ${body.slice(0, 160)}`);
        }
        // Any other 400 is a permanent client error — retrying cannot help, so
        // fail fast and surface the body (this is how we diagnose request-shape issues).
        if (res.status === 400) {
          throw new Error(`Moonshot bad request (HTTP 400): ${body.slice(0, 300)}`);
        }
        // 429 rate limit -> wait out the per-minute window (honor retry-after if given)
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000 + attempt * 15_000;
          lastErr = new Error(`Moonshot rate limit (HTTP 429): ${body.slice(0, 120)}`);
          console.warn(`    [moonshot] rate-limited; waiting ${Math.round(wait / 1000)}s for the window to reset (attempt ${attempt}/${maxRetries})`);
          await sleep(wait);
          continue;
        }
        // 5xx -> short backoff and retry same model
        lastErr = new Error(`Moonshot HTTP ${res.status}: ${body.slice(0, 160)}`);
        console.warn(`    [moonshot] HTTP ${res.status}; retry ${attempt}/${maxRetries}`);
        await sleep(4000 * attempt);
      }
      // Rate limits are account-wide — trying other model candidates just burns time.
      if (lastErr && /429|rate limit/i.test(lastErr.message)) throw lastErr;
    }
    throw lastErr || new Error('Moonshot call failed for all model candidates');
  }
}

// ── Prompt construction (mirrors the manual specialist chats) ──
export const SYSTEM_PROMPT = `You are a specialist-fixer for Mach-Speed, a modular static analysis engine that scans GitHub repos for deployment readiness. You rewrite ONE specialist module per request.

OUTPUT RULES (strict):
- Reply with ONLY the complete rewritten module in a single \`\`\`javascript code block.
- No prose, no explanation, no extra code blocks — just the one block.
- The module must be self-contained (no new dependencies) and follow the contract exactly.`;

function buildFixPrompt(checkId, evidenceMd, currentCode) {
  return `# YOUR CONTRACT
Every specialist MUST export these 4 things:
- checkId: unique string ID (keep it EXACTLY '${checkId}')
- name: human-readable name (keep the existing one)
- appliesTo: array of repo types this runs on (keep the existing array)
- check(context): async function that returns { checkId, status, confidence, message, findings }

Repo types: 'empty', 'library', 'deployable', 'server', 'framework', 'tool', 'unknown'
Statuses: 'pass', 'fail', 'check-it', 'not-applicable'
Confidences: 'high', 'medium', 'low'
findings: array of { file, line?, issue }

The context object gives you:
- tree: array of ALL file paths in the repo (directories included)
- files: { get(path) => Promise<string|null>, has(path) => boolean } — lazy file loader; get() may return null
- packageJson: parsed package.json or null
- repoType: what the classifier decided — IT CAN BE WRONG, sanity-check with your own signals
- owner, repo: strings

# GROUND RULES
1. BE DECISIVE — "check-it" is the LAST resort, not the default. Clear evidence -> pass/fail. Check clearly irrelevant -> not-applicable. check-it only when genuinely undecidable, and ALWAYS with findings attached.
2. LOG ERRORS — catch blocks MUST console.error() the real error before any fallback return.
3. WORK ACROSS ALL REPO TYPES — libraries, deployable apps, servers, frameworks, tools.
4. SUPPORT MODERN TOOLING — pnpm workspaces, Turborepo, Vite, Drizzle ORM, Cloudflare Workers/wrangler, Bun, Deno, Nitro, monorepo layouts (apps/*, packages/*).
5. NO REPO-SPECIFIC HACKS — never check owner/repo names. Logic must generalize to ANY repo.
6. USE THE TREE — tree.includes() for existence; files.get() only when content is needed. Keep file reads bounded (cap + prioritize).
7. In the scorecard, check-it scores HALF credit and fail scores ZERO — over-caution and false fails both hurt users.

# EVIDENCE (holistic problems detected across 15 real public repos — fix THESE)
${evidenceMd}

# CURRENT MODULE CODE (specialists/${checkId}.js)
\`\`\`javascript
${currentCode}
\`\`\`

# YOUR TASK
Rewrite the module to fix ALL holistic problems in the evidence while preserving the contract exactly (same checkId, name, appliesTo). Return ONLY the complete module in one \`\`\`javascript code block.`;
}

// ── Response extraction + validation ──
export function extractModule(text) {
  const fenced = text.match(/```(?:javascript|js|mjs)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const t = text.trim();
  if (/^(export|\/\/|\/\*|#!)/.test(t)) return t; // raw module without fence
  return null;
}

export function validateModuleSource(checkId, code) {
  const problems = [];
  const idRe = new RegExp(`export\\s+const\\s+checkId\\s*=\\s*['"]${checkId}['"]`);
  if (!idRe.test(code)) problems.push(`missing or wrong export const checkId = '${checkId}'`);
  if (!/export\s+const\s+name\s*=\s*['"]/.test(code)) problems.push('missing export const name');
  if (!/export\s+const\s+appliesTo\s*=\s*\[/.test(code)) problems.push('missing export const appliesTo = [...]');
  if (!/export\s+(async\s+)?function\s+check\s*\(/.test(code)) problems.push('missing export async function check(context)');
  if (code.length < 500) problems.push('module suspiciously short (<500 chars) — likely truncated');
  return problems;
}

// Write to a temp path at the SAME directory level as real specialists so relative
// imports (../contract.js) resolve identically, then syntax-check and run the
// contract test-harness against it. Dot-prefixed name => never picked up by central.js.
export function validateModuleRuntime(checkId, code, repoRoot) {
  const tmpFile = path.join(repoRoot, 'specialists', `.autofix-${checkId}.js`);
  fs.writeFileSync(tmpFile, code);
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } catch (err) {
    return [`syntax error: ${String(err.stderr || err.message).slice(0, 300)}`];
  }
  try {
    const out = execFileSync(process.execPath, ['test-harness.js', path.join('specialists', `.autofix-${checkId}.js`)], {
      cwd: repoRoot, stdio: 'pipe', timeout: 60_000,
    }).toString();
    if (!/ALL TESTS PASSED/.test(out)) return [`test-harness failed: ${out.slice(-400)}`];
    return [];
  } catch (err) {
    return [`test-harness crashed: ${String(err.stdout || '').slice(-300)} ${String(err.stderr || err.message).slice(0, 300)}`.trim()];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
  }
}

// ── Thread persistence (local dir, or the auto-fix-state branch when a GitHub token is available) ──
export class ThreadStore {
  constructor(gh, localDir) {
    this.gh = gh;           // GitHubApi or null
    this.localDir = localDir;
  }
  async load(checkId) {
    if (this.gh) {
      const file = await this.gh.getFile(`threads/${checkId}.json`, STATE_BRANCH);
      if (file) { try { return JSON.parse(file.content); } catch { /* corrupted -> fresh thread */ } }
      return [];
    }
    try { return JSON.parse(fs.readFileSync(path.join(this.localDir, `${checkId}.json`), 'utf8')); }
    catch { return []; }
  }
  async save(checkId, messages) {
    // Keep the thread bounded: only the last N messages survive between runs.
    const trimmed = messages.slice(-MAX_THREAD_MESSAGES);
    if (this.gh) {
      await this.gh.putFile(`threads/${checkId}.json`, JSON.stringify(trimmed, null, 2), STATE_BRANCH,
        `auto-fix: update thread for ${checkId}`);
      return;
    }
    fs.mkdirSync(this.localDir, { recursive: true });
    fs.writeFileSync(path.join(this.localDir, `${checkId}.json`), JSON.stringify(trimmed, null, 2));
  }
}

// ── Minimal GitHub REST helper (uses the fetch middleware from auto-heal.js) ──
export class GitHubApi {
  constructor(owner, repo) {
    this.owner = owner;
    this.repo = repo;
    this.base = `https://api.github.com/repos/${owner}/${repo}`;
  }
  async req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${url} -> ${res.status}: ${t.slice(0, 200)}`);
    }
    return res.json();
  }
  async defaultBranchSha() {
    const data = await this.req('GET', `${this.base}/git/ref/heads/main`);
    return data.object.sha;
  }
  async ensureBranch(branch, fromSha) {
    const existing = await this.req('GET', `${this.base}/git/ref/heads/${branch}`);
    if (existing) return existing.object.sha;
    const created = await this.req('POST', `${this.base}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
    return created.object.sha;
  }
  async resetBranch(branch, sha) {
    // Force-update an existing branch to a new base (returns false if it doesn't exist).
    const existing = await this.req('GET', `${this.base}/git/ref/heads/${branch}`);
    if (!existing) return false;
    await this.req('PATCH', `${this.base}/git/refs/heads/${branch}`, { sha, force: true });
    return true;
  }
  async getFile(filePath, ref) {
    const data = await this.req('GET', `${this.base}/contents/${filePath}?ref=${encodeURIComponent(ref)}`);
    if (!data || !data.content) return null;
    return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  }
  async putFile(filePath, content, branch, message) {
    const existing = await this.getFile(filePath, branch);
    await this.req('PUT', `${this.base}/contents/${filePath}`, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(existing ? { sha: existing.sha } : {}),
    });
  }
  async openOrUpdatePr(branch, title, body) {
    const pulls = await this.req('GET', `${this.base}/pulls?head=${this.owner}:${encodeURIComponent(branch)}&state=open`);
    if (pulls && pulls.length > 0) return { url: pulls[0].html_url, number: pulls[0].number, existed: true };
    try {
      const pr = await this.req('POST', `${this.base}/pulls`, { title, head: branch, base: 'main', body });
      return { url: pr.html_url, number: pr.number, existed: false };
    } catch (err) {
      if (/403|not permitted|forbidden/i.test(err.message)) {
        throw new Error(`cannot create pull request (403). Fix: repo Settings → Actions → General → Workflow permissions → enable "Allow GitHub Actions to create and approve pull requests". Original error: ${err.message}`);
      }
      throw err;
    }
  }
  async commentOnPr(number, body) {
    await this.req('POST', `${this.base}/issues/${number}/comments`, { body });
  }
  async mergePr(number) {
    // Squash-merge: one clean commit on main per specialist, easy to revert.
    return this.req('PUT', `${this.base}/pulls/${number}/merge`, { merge_method: 'squash' });
  }
  async deleteBranch(branch) {
    await this.req('DELETE', `${this.base}/git/ref/heads/${encodeURIComponent(branch)}`);
  }
  async createTag(tag, sha) {
    await this.req('POST', `${this.base}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  }
}

// ── Evidence scanning: which specialists need fixing? ──
export function scanEvidence(evidenceDir) {
  const reportPath = path.join(evidenceDir, 'report.json');
  if (!fs.existsSync(reportPath)) {
    throw new Error(`no report.json in ${evidenceDir} — run auto-heal.js first`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.incomplete) {
    console.error('\n  REFUSING TO FIX: the evidence run was INCOMPLETE (not enough repos analyzed).');
    console.error('  Fixing from partial evidence would bake in bad conclusions. Re-run auto-heal.js');
    console.error('  with a GITHUB_TOKEN until the run is complete, then run auto-fix again.\n');
    process.exit(2);
  }
  return (report.specialistReports || [])
    .filter(r => r.severityScore > 0 && !r.insufficientData)
    .sort((a, b) => b.severityScore - a.severityScore);
}

// ── Fix one specialist (Moonshot call + validation + optional retry) ──
async function fixSpecialist(checkId, severity, evidenceMd, ctx) {
  const { moonshot, threads, repoRoot, retries, saveLock } = ctx;
  const specPath = path.join(repoRoot, 'specialists', `${checkId}.js`);
  if (!fs.existsSync(specPath)) {
    return { checkId, ok: false, reason: `specialists/${checkId}.js not found — skipped` };
  }
  const currentCode = fs.readFileSync(specPath, 'utf8');

  const thread = await threads.load(checkId);
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...thread];
  messages.push({ role: 'user', content: buildFixPrompt(checkId, evidenceMd, currentCode) });

  for (let round = 0; round <= retries; round++) {
    await sleep(CALL_SPACING_MS);
    const reply = await moonshot.chat(messages);
    messages.push({ role: 'assistant', content: reply });

    const code = extractModule(reply);
    let problems = code ? validateModuleSource(checkId, code) : ['no javascript code block found in the reply'];
    if (code && problems.length === 0) {
      problems = validateModuleRuntime(checkId, code, repoRoot);
    }

    if (problems.length === 0) {
      await saveLock(() => threads.save(checkId, messages.slice(1))); // persist without the system prompt
      return { checkId, ok: true, code, rounds: round + 1 };
    }

    console.log(`    [${checkId}] validation failed (round ${round + 1}): ${problems[0]}`);
    if (round < retries) {
      messages.push({ role: 'user', content:
        `Your previous reply failed validation:\n${problems.map(p => `- ${p}`).join('\n')}\n\n` +
        `Return the COMPLETE corrected module in ONE \`\`\`javascript code block, fixing these issues. No prose.` });
    } else {
      await saveLock(() => threads.save(checkId, messages.slice(1)));
      return { checkId, ok: false, reason: `validation failed after ${retries + 1} attempt(s): ${problems.join('; ')}` };
    }
  }
}

// ── Main ──
export async function autofix(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv);
  const repoRoot = process.cwd();

  console.log('\n  Mach-Speed Auto-Fix');
  console.log('  ===================');
  console.log(`  Evidence: ${opt.evidence} | mode: ${opt.dryRun ? 'dry-run' : opt.pr ? 'PR' : 'local'}`);

  let queue = scanEvidence(opt.evidence);
  if (opt.only) queue = queue.filter(r => opt.only.includes(r.checkId));
  queue = queue.slice(0, opt.maxFixes);

  if (queue.length === 0) {
    console.log('  Nothing to fix — no specialists with patterns. Suite is healthy.');
    return { fixed: [], failed: [], skipped: [] };
  }
  console.log(`  Fix queue (${queue.length}): ${queue.map(r => `${r.checkId}(${r.severityScore})`).join(', ')}\n`);
  if (opt.dryRun) {
    for (const r of queue) console.log(`    would fix: ${r.checkId} — severity ${r.severityScore}, patterns: ${r.patterns.join(', ')}`);
    console.log('\n  Dry run only. Re-run without --dry-run (and with MOONSHOT_API_KEY) to fix.');
    return { fixed: [], failed: [], skipped: queue.map(r => r.checkId) };
  }

  installFetchMiddleware(); // auth + retries for api.github.com calls (uses GITHUB_TOKEN)
  const moonshot = new Moonshot();

  // Preflight: one tiny call proves the key can actually run inference BEFORE
  // we spend time on specialists. Fails fast with actionable guidance.
  console.log(`  Moonshot key: ${moonshot.fingerprint()} (${moonshot.baseUrl})`);
  try {
    await moonshot.chat([{ role: 'user', content: 'Reply with the single word: ok' }], { maxRetries: 1 });
    console.log(`  Moonshot preflight OK — using model: ${moonshot.model}`);
  } catch (err) {
    if (err.fatalPermission) {
      // Most common cause: the key belongs to the OTHER Moonshot platform
      // (.ai vs .cn). Probe it before giving up — maybe we can self-heal.
      console.warn(`  Inference denied on ${moonshot.baseUrl} — probing the other Moonshot region...`);
      if (await moonshot.tryAlternateRegion()) {
        console.log(`  Moonshot preflight OK on alternate region — using model: ${moonshot.model}`);
      } else {
        console.error('\n  MOONSHOT PERMISSION DENIED — account problem, not a code problem.');
        console.error(`  Key ${moonshot.fingerprint()} authenticates (the model list call works) but cannot`);
        console.error('  run ANY model on EITHER Moonshot platform (.ai or .cn). To fix:');
        console.error('    1. Check which console your account lives on: platform.moonshot.ai vs platform.moonshot.cn');
        console.error('    2. Check balance/billing there (inference requires a positive balance)');
        console.error('    3. If the console is .cn, add a GitHub secret MOONSHOT_BASE_URL = https://api.moonshot.cn/v1');
        console.error('    4. Re-run this workflow. Nothing was changed; threads keep their memory.\n');
        process.exit(3);
      }
    } else if (/429|rate limit/i.test(err.message)) {
      console.warn('  Preflight hit the rate limit — the key has inference permission; proceeding (calls pace themselves).');
    } else {
      throw err;
    }
  }

  // Threads + PRs need the repo coordinates
  const repoSlug = opt.repo || process.env.GITHUB_REPOSITORY || null;
  let gh = null;
  if (opt.pr || process.env.GITHUB_TOKEN) {
    if (!repoSlug) throw new Error('need --repo owner/name (or GITHUB_REPOSITORY) for remote threads/PRs');
    const [owner, repo] = repoSlug.split('/');
    gh = new GitHubApi(owner, repo);
  }
  if (opt.pr && !process.env.GITHUB_TOKEN) throw new Error('--pr needs GITHUB_TOKEN');
  if (gh) await gh.ensureBranch(STATE_BRANCH, await gh.defaultBranchSha());

  // Remote threads whenever we have repo access — they survive between nights and
  // are shared with auto-verify.js (which continues the same per-specialist chats).
  const threads = new ThreadStore(gh, path.join(repoRoot, 'threads'));
  fs.mkdirSync(opt.out, { recursive: true });

  const fixed = [], failed = [];
  // Thread saves commit to the shared state branch — serialize them (the Moonshot
  // chats themselves run FIX_CONCURRENCY-wide) so concurrent branch commits can't race.
  let saveChain = Promise.resolve();
  const saveLock = (fn) => { const p = saveChain.then(fn); saveChain = p.catch(() => {}); return p; };
  await pool(queue, FIX_CONCURRENCY, async (item, ctrl) => {
    const { checkId, severityScore } = item;
    console.log(`  Fixing ${checkId} (severity ${severityScore})...`);
    const evidenceMd = fs.readFileSync(path.join(opt.evidence, `${checkId}.md`), 'utf8');
    try {
      const result = await fixSpecialist(checkId, severityScore, evidenceMd, {
        moonshot, threads, repoRoot, retries: opt.retries, saveLock,
      });
      if (!result.ok) {
        console.log(`    [${checkId}] SKIPPED: ${result.reason}`);
        failed.push({ checkId, reason: result.reason });
        return;
      }
      fs.writeFileSync(path.join(opt.out, `${checkId}.js`), result.code);

      if (opt.pr && gh) {
        const branch = `auto-fix/${checkId}`;
        await gh.ensureBranch(branch, await gh.defaultBranchSha());
        await gh.putFile(`specialists/${checkId}.js`, result.code, branch,
          `auto-fix(${checkId}): rewrite from auto-heal evidence (severity ${severityScore})`);
        const pr = await gh.openOrUpdatePr(branch,
          `auto-fix(${checkId}): rewrite from auto-heal evidence`,
          prBody(item, result, moonshot));
        console.log(`    [${checkId}] ${pr.existed ? 'updated' : 'opened'} PR: ${pr.url}`);
        fixed.push({ checkId, pr: pr.url, rounds: result.rounds });
      } else {
        console.log(`    [${checkId}] OK -> ${opt.out}/${checkId}.js (${result.rounds} round(s))`);
        fixed.push({ checkId, file: `${opt.out}/${checkId}.js`, rounds: result.rounds });
      }
    } catch (err) {
      console.error(`    [${checkId}] ERROR: ${err.message}`);
      failed.push({ checkId, reason: err.message });
      if (err.fatalPermission) {
        console.error('\n  ABORTING EARLY: Moonshot permission denied is account-wide — no specialist can succeed.');
        ctrl.stop();
      } else if (/429|rate limit/i.test(err.message)) {
        console.error('\n  ABORTING EARLY: the Moonshot rate limit persists after waiting.');
        console.error('  Your account tier is throttling requests — check https://platform.moonshot.ai/console/limits');
        console.error('  Nothing was lost: threads keep their memory and the next scheduled run resumes.');
        ctrl.stop();
      }
    }
  });

  // ── Report ──
  const report = {
    generatedAt: new Date().toISOString(),
    model: moonshot.model,
    usage: moonshot.usage,
    fixed, failed,
  };
  fs.writeFileSync('autofix-report.json', JSON.stringify(report, null, 2));
  const md = [
    '# Mach-Speed Auto-Fix Report', '',
    `**Generated:** ${new Date().toUTCString()}`,
    `**Model:** ${moonshot.model || '(none)'}`,
    `**Tokens:** ${moonshot.usage.prompt_tokens} in / ${moonshot.usage.completion_tokens} out (${moonshot.usage.calls} calls)`, '',
    '## Fixed', ...fixed.map(f => `- **${f.checkId}** ${f.pr ? `→ [PR](${f.pr})` : `→ \`${f.file}\``} (${f.rounds} round(s))`), '',
    '## Failed / skipped', ...(failed.length ? failed.map(f => `- **${f.checkId}** — ${f.reason}`) : ['(none)']), '',
  ];
  fs.writeFileSync('autofix-report.md', md.join('\n'));

  console.log(`\n  Done. Fixed: ${fixed.length}, failed/skipped: ${failed.length}.`);
  console.log(`  Tokens used: ${moonshot.usage.prompt_tokens} in / ${moonshot.usage.completion_tokens} out.`);
  if (!opt.pr && fixed.length) console.log(`  Review the rewrites in ${opt.out}/ then copy them into specialists/ (or re-run with --pr).`);
  console.log('');
  return report;
}

function prBody(item, result, moonshot) {
  return [
    `## Auto-fix: \`${item.checkId}\``,
    '',
    `Generated by **auto-fix.js** from auto-heal evidence (${moonshot.model}).`,
    '',
    `- **Severity score:** ${item.severityScore}`,
    `- **Patterns fixed:** ${item.patterns.join(', ')}`,
    `- **Validation:** contract exports ✓ · \`node --check\` ✓ · test-harness ✓ (${result.rounds} round(s))`,
    `- **Evidence:** see \`evidence/${item.checkId}.md\` in the auto-heal artifacts`,
    '',
    '**Review notes:** the fix is holistic (patterns across 15 public repos), not tuned to any single repo.',
    'Re-run auto-heal after merging to confirm the patterns are gone.',
  ].join('\n');
}

// ── Run only when executed directly ──
import { pathToFileURL } from 'url';
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  autofix().catch(err => {
    console.error('\n  Fatal error:', err.message);
    process.exit(1);
  });
}
