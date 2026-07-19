/**
 * Specialist: AI API Configuration
 * Detects AI API (OpenAI, Anthropic, Google) integration and checks if API
 * keys are safely configured. The #1 security mistake in vibe-coded apps is
 * exposing AI keys in frontend code.
 */

export const checkId = 'ai-api-config';
export const name = 'AI API Configuration';
export const appliesTo = ['deployable', 'server', 'framework', 'library'];

// ── Detection data ─────────────────────────────────────────────────────

const AI_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  'ai',
  '@vercel/ai',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  'langchain',
  '@langchain/openai',
  'llamaindex',
  'cohere-ai',
  '@mistralai/mistralai',
  'replicate',
  '@replit/ai',
  'replit-ai',
  '@replit/ai-modelfarm',
];

const JS_RE = /\.(js|ts|jsx|tsx|mjs|cjs)$/;

const EXPOSED_KEY_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}/,                        // Raw OpenAI key
  /\bsk-proj-[a-zA-Z0-9]{20,}/,                   // OpenAI project key
  /apiKey\s*[:=]\s*["']sk-/,                      // Named variable with hardcoded key
  /new\s+OpenAI\s*\(\s*\{\s*apiKey\s*:\s*["']/,   // Client init with string key
];

// Direct fetch to an AI API from frontend (key is likely nearby)
const DIRECT_FETCH_PATTERNS = [
  /fetch\s*\(\s*["']https:\/\/api\.openai\.com/,
  /fetch\s*\(\s*["']https:\/\/api\.anthropic\.com/,
];

// NEXT_PUBLIC_ prefix = exposed to the browser in Next.js
const NEXT_PUBLIC_KEY = /NEXT_PUBLIC_OPENAI_API_KEY/;

// Signs of a server-side AI proxy route
const BACKEND_PROXY_PATTERNS = [
  /openai\.chat\.completions\.create/,
  /anthropic\.messages\.create/,
  /new\s+OpenAI\s*\(\s*\{/,
];

const isFile = (p) => !p.endsWith('/');

// ── Main check ─────────────────────────────────────────────────────────

export async function check(context) {
  try {
    const { tree, files, packageJson } = context;

    // Step 1: tree-level check — does the repo use AI APIs at all? (zero file reads)
    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    const hasAiPackage = AI_PACKAGES.some((p) => deps[p]);
    if (!hasAiPackage) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'No AI API integration detected', findings: [] };
    }

    // Step 2: select frontend files to scan (prioritize .tsx/.jsx)
    let candidates = tree.filter((p) =>
      isFile(p) && /\.(tsx|jsx)$/.test(p) &&
      !/node_modules/.test(p) && !/\.test\./.test(p) && !/\.spec\./.test(p));

    // If few TSX/JSX, add TS/JS from src/ and app/
    if (candidates.length < 10) {
      const extras = tree.filter((p) =>
        isFile(p) && JS_RE.test(p) &&
        !/node_modules/.test(p) && !/\.test\./.test(p) && !/\.spec\./.test(p) &&
        !/\.(tsx|jsx)$/.test(p) &&
        /^(src|app|pages|components|lib)\//.test(p));
      candidates = candidates.concat(extras);
    }
    const filesToScan = candidates.slice(0, 15);

    // Step 3: line-by-line scan of frontend files for exposed API keys
    const findings = [];
    for (const filePath of filesToScan) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trimStart();
          if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

          if (EXPOSED_KEY_PATTERNS.some((pat) => pat.test(line))) {
            findings.push({ file: filePath, line: i + 1, issue: 'AI API key exposed in frontend code — move to backend env var' });
          }
          if (DIRECT_FETCH_PATTERNS.some((pat) => pat.test(line))) {
            findings.push({ file: filePath, line: i + 1, issue: 'Direct fetch to AI API from frontend — API key may be exposed' });
          }
          if (NEXT_PUBLIC_KEY.test(line)) {
            findings.push({ file: filePath, line: i + 1, issue: 'NEXT_PUBLIC_OPENAI_API_KEY — key is exposed in browser bundle. Use backend proxy instead.' });
          }
        }
      } catch { /* skip file */ }
    }

    // Step 4: check for a backend proxy route (scan up to 10 backend files)
    const backendFiles = tree.filter((p) =>
      isFile(p) && JS_RE.test(p) && !/node_modules/.test(p) &&
      (/\/(api|routes|server|lib)\//.test(p) || /^(api|routes|server|lib)\//.test(p))
    ).slice(0, 10);

    let hasBackendProxy = false;
    for (const filePath of backendFiles) {
      try {
        const content = await files.get(filePath);
        if (!content) continue;
        if (BACKEND_PROXY_PATTERNS.some((pat) => pat.test(content))) {
          hasBackendProxy = true;
          break;
        }
      } catch { /* skip file */ }
    }

    // Decision matrix
    if (findings.some((f) => f.issue.includes('exposed in frontend code'))) {
      return { checkId, status: 'fail', confidence: 'high', message: 'OpenAI/Anthropic API key exposed in frontend — anyone can steal it', findings };
    }
    if (findings.some((f) => f.issue.includes('NEXT_PUBLIC_'))) {
      return { checkId, status: 'check-it', confidence: 'high', message: 'AI key exposed via NEXT_PUBLIC_ — visible in browser bundle. Use backend proxy.', findings };
    }
    if (hasBackendProxy) {
      return { checkId, status: 'pass', confidence: 'high', message: 'AI API configured safely — backend proxy detected', findings: [] };
    }
    return { checkId, status: 'check-it', confidence: 'medium', message: 'AI SDK detected but no backend proxy found — verify keys are server-side only', findings };

  } catch (err) {
    console.error('ai-api-config check error:', err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error: ${err.message}`,
      findings: [{ file: 'internal', issue: `Fatal error: ${err.message}` }],
    };
  }
}
