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

const AI_IMPORT_RE = /(?:import\s+(?:.*?\s+from\s+)?|require\s*\(\s*)["'](openai|@anthropic-ai\/sdk|@google\/generative-ai|ai|@vercel\/ai|@ai-sdk\/openai|@ai-sdk\/anthropic|langchain|@langchain\/openai|llamaindex|cohere-ai|@mistralai\/mistralai|replicate|@replit\/ai|replit-ai|@replit\/ai-modelfarm)["']/;
const AI_USAGE_RE = /\bnew\s+(?:OpenAI|Anthropic|GoogleGenerativeAI|Replicate|MistralClient)\s*\(/;

const EXPOSED_KEY_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}/,
  /\bsk-proj-[a-zA-Z0-9]{20,}/,
  /apiKey\s*[:=]\s*["']sk-/,
  /new\s+OpenAI\s*\(\s*\{\s*apiKey\s*:\s*["']/,
  /new\s+Anthropic\s*\(\s*\{\s*apiKey\s*:\s*["']/,
];

const DIRECT_FETCH_PATTERNS = [
  /fetch\s*\(\s*["']https:\/\/api\.openai\.com/,
  /fetch\s*\(\s*["']https:\/\/api\.anthropic\.com/,
];

const NEXT_PUBLIC_KEY = /NEXT_PUBLIC_(OPENAI|ANTHROPIC|AI|GOOGLE|REPLICATE|MISTRAL)_API_KEY/;

const BACKEND_PROXY_PATTERNS = [
  /openai\.chat\.completions\.create/,
  /anthropic\.messages\.create/,
  /new\s+OpenAI\s*\(\s*\{/,
  /new\s+Anthropic\s*\(\s*\{/,
];

// ── Helpers ────────────────────────────────────────────────────────────

const isFile = (p) => !p.endsWith('/');

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/');
}

// ── Main check ─────────────────────────────────────────────────────────

export async function check(context) {
  try {
    const { tree, files, packageJson } = context;

    // Step 1: Detect AI integration (package.json or sampled source files)
    const deps = { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
    let aiDetected = AI_PACKAGES.some((p) => deps[p]);

    const allSourceFiles = tree.filter((p) =>
      isFile(p) &&
      JS_RE.test(p) &&
      !/node_modules/.test(p) &&
      !/\.test\./.test(p) &&
      !/\.spec\./.test(p) &&
      !/\.d\.ts$/.test(p)
    );

    if (!aiDetected) {
      const isExampleOrDoc = (p) => /(^|\/)(examples?|docs?|fixtures|tests?|__tests__|e2e|playground|benchmarks|scripts|tools|ci|\.github)\//.test(p);
      let samples = allSourceFiles.filter((p) =>
        !isExampleOrDoc(p) &&
        /[\/-](ai|openai|anthropic|llm|chat|gpt|claude)/i.test(p)
      );
      samples.push(...allSourceFiles.filter((p) => !isExampleOrDoc(p) && !samples.includes(p)));
      samples = samples.slice(0, 20);

      for (const fp of samples) {
        try {
          const content = await files.get(fp);
          if (!content) continue;
          const lines = content.split('\n');
          for (const line of lines) {
            if (isCommentLine(line)) continue;
            if (AI_IMPORT_RE.test(line) || AI_USAGE_RE.test(line)) {
              aiDetected = true;
              break;
            }
          }
          if (aiDetected) break;
        } catch (e) {
          console.error(`ai-api-config detection error in ${fp}:`, e);
        }
      }
    }

    if (!aiDetected) {
      return { checkId, status: 'not-applicable', confidence: 'high', message: 'No AI API integration detected', findings: [] };
    }

    // Step 2: Select files to scan for exposure (prioritise public & frontend)
    const isPublicDir = (p) =>
      /\/(public|static|wwwroot|dist|\.output\/public|storybook-static)\//.test(p) ||
      /^(public|static|wwwroot|dist|\.output\/public|storybook-static)\//.test(p);

    const isFrontendDir = (p) =>
      /\/(src|app|pages|components|lib|client|frontend|web|ui|hooks)\//.test(p) ||
      /^(src|app|pages|components|lib|client|frontend|web|ui|hooks)\//.test(p);

    let scanTargets = [];
    scanTargets.push(...allSourceFiles.filter((p) => isPublicDir(p)));
    scanTargets.push(...allSourceFiles.filter((p) => /\.(jsx|tsx)$/.test(p) && !scanTargets.includes(p)));
    scanTargets.push(...allSourceFiles.filter((p) => isFrontendDir(p) && !scanTargets.includes(p)));
    scanTargets.push(...allSourceFiles.filter((p) => !scanTargets.includes(p)));
    const filesToScan = scanTargets.slice(0, 25);

    const findings = [];
    for (const fp of filesToScan) {
      try {
        const content = await files.get(fp);
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (isCommentLine(line)) continue;

          if (EXPOSED_KEY_PATTERNS.some((pat) => pat.test(line))) {
            findings.push({ file: fp, line: i + 1, issue: 'AI API key exposed in source code — move to backend env var' });
          }
          if (DIRECT_FETCH_PATTERNS.some((pat) => pat.test(line))) {
            findings.push({ file: fp, line: i + 1, issue: 'Direct fetch to AI API from potential frontend code — API key may be exposed' });
          }
          if (NEXT_PUBLIC_KEY.test(line)) {
            findings.push({ file: fp, line: i + 1, issue: 'AI key exposed via NEXT_PUBLIC_ env prefix — visible in browser bundle' });
          }
        }
      } catch (e) {
        console.error(`ai-api-config scan error in ${fp}:`, e);
      }
    }

    // Step 3: Look for a real backend proxy route (skip comments)
    const isBackendDir = (p) =>
      /\/(api|routes|server|backend|lib|middleware|functions|workers|services)\//.test(p) ||
      /^(api|routes|server|backend|lib|middleware|functions|workers|services)\//.test(p);

    let backendCandidates = allSourceFiles.filter((p) => isBackendDir(p) && !isPublicDir(p));
    if (backendCandidates.length < 10) {
      const rest = allSourceFiles.filter((p) => !isPublicDir(p) && !backendCandidates.includes(p));
      backendCandidates = backendCandidates.concat(rest);
    }
    backendCandidates = backendCandidates.slice(0, 15);

    let hasBackendProxy = false;
    for (const fp of backendCandidates) {
      try {
        const content = await files.get(fp);
        if (!content) continue;
        const lines = content.split('\n');
        for (const line of lines) {
          if (isCommentLine(line)) continue;
          if (BACKEND_PROXY_PATTERNS.some((pat) => pat.test(line))) {
            hasBackendProxy = true;
            break;
          }
        }
        if (hasBackendProxy) break;
      } catch (e) {
        console.error(`ai-api-config backend scan error in ${fp}:`, e);
      }
    }

    // Step 4: Decision matrix
    const exposedKeyFindings = findings.filter((f) => f.issue.includes('AI API key exposed'));
    const nextPublicFindings = findings.filter((f) => f.issue.includes('NEXT_PUBLIC_'));
    const directFetchFindings = findings.filter((f) => f.issue.includes('Direct fetch'));

    if (exposedKeyFindings.length > 0 || nextPublicFindings.length > 0) {
      const inPublic = [...exposedKeyFindings, ...nextPublicFindings].some((f) => isPublicDir(f.file));
      const message = inPublic
        ? 'AI API key exposed in public/frontend code — anyone can steal it'
        : 'AI API key appears exposed in source — verify it is not served to the browser';
      return {
        checkId,
        status: inPublic ? 'fail' : 'check-it',
        confidence: 'high',
        message,
        findings: [...exposedKeyFindings, ...nextPublicFindings],
      };
    }

    if (directFetchFindings.length > 0) {
      return {
        checkId,
        status: 'check-it',
        confidence: 'high',
        message: 'Direct AI API fetch detected in potential frontend code — verify keys are not exposed',
        findings: directFetchFindings,
      };
    }

    if (hasBackendProxy) {
      return { checkId, status: 'pass', confidence: 'high', message: 'AI API configured safely — backend proxy detected', findings: [] };
    }

    return {
      checkId,
      status: 'check-it',
      confidence: 'medium',
      message: 'AI SDK detected but no backend proxy found — verify keys are server-side only',
      findings: [{ file: 'internal', issue: 'AI SDK detected but no clear backend proxy or env configuration found — manual review required' }],
    };
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