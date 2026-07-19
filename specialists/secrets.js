/**
 * Specialist: Hardcoded Secrets Detection
 * Scans source files for potential hardcoded secrets: API keys, tokens,
 * passwords, private keys, database URLs with credentials.
 */

export const checkId = 'secrets';
export const name = 'No Hardcoded Secrets';
export const appliesTo = ['all'];

// ── Patterns ───────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  { regex: /\b(sk-[a-zA-Z0-9]{20,})/, name: 'API key (sk- prefix)' },
  { regex: /\b(pk_[a-zA-Z0-9_]{20,})/, name: 'API key (pk_ prefix)' },
  { regex: /\b(ghp_[a-zA-Z0-9]{36})/, name: 'GitHub token' },
  { regex: /\b(gho_[a-zA-Z0-9]{36})/, name: 'GitHub OAuth token' },
  { regex: /\b(AIza[0-9A-Za-z_\-]{35})/, name: 'Google API key' },
  { regex: /\b(Bearer\s+[a-zA-Z0-9_\-\.]{20,})/, name: 'Bearer token' },
  { regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, name: 'Private key', captureGroup: -1 },
  { regex: /((?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@)/, name: 'DB URL with password', captureGroup: 1 },
  { regex: /(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*["\']([a-zA-Z0-9]{16,})["\']/i, name: 'Hardcoded credential', captureGroup: 1 },
];

const SAFE_PATTERNS = [
  /localhost/i,
  /127\.0\.0\.1/,
  /example\.com/i,
  /\btest_/i,
  /dummy/i,
  /placeholder/i,
  /changeme/i,
  /YOUR_/i,
  /XXXX/i,
  /REDACTED/i,
  /process\.env\./,
  /import\.meta\.env\./,
  /Deno\.env/,
  /Bun\.env/,
];

const SKIP_PATHS = [
  /test/i, /spec/i, /__tests__/, /examples?/, /fixtures/, /docs?/,
  /\.md$/, /\.test\./, /\.spec\./, /\.d\.ts$/, /\.lock$/, /\.env\./, /\.env$/, /mock/i, /snapshot/,
];

const VENDOR_PATHS = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)\.yarn\//,
  /(?:^|\/)\.pnpm\//,
  /(?:^|\/)vendor\//,
  /(?:^|\/)third_party\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)\.nuxt\//,
  /(?:^|\/)out\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)\_next\//,
  /(?:^|\/)\.turbo\//,
  /(?:^|\/)\.parcel-cache\//,
  /(?:^|\/)\.webpack\//,
  /(?:^|\/)\.cache\//,
  /(?:^|\/)\.output\//,
  /(?:^|\/)\.vercel\//,
  /(?:^|\/)\.netlify\//,
];

const SCANNABLE_EXTS = /\.(js|ts|jsx|tsx|mjs|cjs|py|rb|go|java|kt|rs)$/;

// ── Helpers ────────────────────────────────────────────────────────────

function shouldScanFile(path) {
  if (!SCANNABLE_EXTS.test(path)) return false;
  if (SKIP_PATHS.some((p) => p.test(path))) return false;
  if (VENDOR_PATHS.some((p) => p.test(path))) return false;
  return true;
}

function isSafeLine(line) {
  return SAFE_PATTERNS.some((p) => p.test(line));
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('#')
  );
}

function getEntropy(str) {
  const len = str.length;
  if (len === 0) return 0;
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let entropy = 0;
  for (const ch in freq) {
    const p = freq[ch] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function extractQuotedStrings(line) {
  const strings = [];
  const re = /(['"])(.*?)\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    strings.push(m[2]);
  }
  return strings;
}

function checkSplitSecret(line) {
  if (!/['"]\s*\+\s*['"]/.test(line)) return null;

  const strings = extractQuotedStrings(line);
  if (strings.length < 2) return null;

  const combined = strings.join('');
  if (combined.length < 16) return null;
  if (combined.includes(' ')) return null;

  const prefixes = ['AKIA', 'ASIA', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'AIza', 'npm_', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'sk_live_', 'pk_live_'];
  for (const s of strings) {
    for (const p of prefixes) {
      if (s.includes(p)) return `Potential split hardcoded secret (${p})`;
    }
  }

  if (!/[a-z]/.test(combined) || !/[A-Z]/.test(combined) || !/[0-9]/.test(combined)) return null;
  if (getEntropy(combined) <= 3.5) return null;

  const suspicious = /(?:^|[^a-zA-Z0-9])(key|token|secret|password|passwd|pwd|auth|access|credential)(?:[^a-zA-Z0-9]|$)/i;
  if (!suspicious.test(line)) return null;

  if (/https?:\/\//.test(combined) || /^\//.test(combined)) return null;

  return 'Potential split hardcoded secret';
}

function checkArrayJoinSecret(line) {
  if (!/\.\s*join\s*\(/.test(line)) return null;

  const strings = extractQuotedStrings(line);
  if (strings.length < 2) return null;

  const combined = strings.join('');
  if (combined.length < 16) return null;
  if (combined.includes(' ')) return null;

  const prefixes = ['AKIA', 'ASIA', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'AIza', 'npm_', 'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'sk_live_', 'pk_live_'];
  for (const s of strings) {
    for (const p of prefixes) {
      if (s.includes(p)) return `Potential split hardcoded secret (${p})`;
    }
  }

  if (!/[a-z]/.test(combined) || !/[A-Z]/.test(combined) || !/[0-9]/.test(combined)) return null;
  if (getEntropy(combined) <= 3.5) return null;

  const suspicious = /(?:^|[^a-zA-Z0-9])(key|token|secret|password|passwd|pwd|auth|access|credential)(?:[^a-zA-Z0-9]|$)/i;
  if (!suspicious.test(line)) return null;

  return 'Potential split hardcoded secret via array join';
}

// ── Main Check ─────────────────────────────────────────────────────────

export async function check(context) {
  const { tree, files } = context;

  try {
    const sourceFiles = tree.filter(shouldScanFile).slice(0, 30);
    if (sourceFiles.length === 0) {
      const isEmptyRepo = tree.length === 0;
      return {
        checkId,
        status: 'not-applicable',
        confidence: 'high',
        message: isEmptyRepo ? 'Repo is empty — nothing to scan' : `No scannable source files in ${tree.length} file(s)`,
        findings: [],
      };
    }

    const findings = [];

    for (const filePath of sourceFiles) {
      const content = await files.get(filePath);
      if (!content) continue;

      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isSafeLine(line)) continue;
        if (isCommentLine(line)) continue;

        let found = false;

        for (const pattern of SECRET_PATTERNS) {
          const match = line.match(pattern.regex);
          if (match) {
            const cg = pattern.captureGroup ?? 1;
            let shouldFlag;
            if (cg === -1) {
              shouldFlag = true;
            } else {
              const candidate = match[cg] || match[0];
              shouldFlag = candidate.length > 8 && getEntropy(candidate) > 3.5;
            }

            if (shouldFlag) {
              findings.push({
                file: filePath,
                line: i + 1,
                issue: `Potential ${pattern.name}`,
              });
              found = true;
            }
            break;
          }
        }

        if (!found) {
          const splitIssue = checkSplitSecret(line);
          if (splitIssue) {
            findings.push({
              file: filePath,
              line: i + 1,
              issue: splitIssue,
            });
            found = true;
          }
        }

        if (!found) {
          const joinIssue = checkArrayJoinSecret(line);
          if (joinIssue) {
            findings.push({
              file: filePath,
              line: i + 1,
              issue: joinIssue,
            });
          }
        }
      }
    }

    if (findings.length === 0) {
      return {
        checkId,
        status: 'pass',
        confidence: 'medium',
        message: `No secrets detected in ${sourceFiles.length} scanned file(s)`,
        findings: [],
      };
    }

    return {
      checkId,
      status: 'fail',
      confidence: 'high',
      message: `${findings.length} potential secret(s) found in ${sourceFiles.length} scanned file(s)`,
      findings,
    };
  } catch (err) {
    console.error(err);
    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: `Error during scan: ${err.message}`,
      findings: [],
    };
  }
}