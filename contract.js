// contract.js — Shared constants, types, and validation for the entire platform

export const RepoType = {
  EMPTY: 'empty',
  LIBRARY: 'library',
  DEPLOYABLE: 'deployable',
  SERVER: 'server',
  FRAMEWORK: 'framework',
  TOOL: 'tool',
  UNKNOWN: 'unknown',
};

export const Status = {
  PASS: 'pass',
  FAIL: 'fail',
  CHECK_IT: 'check-it',
  NOT_APPLICABLE: 'not-applicable',
};

export const Confidence = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

export const Severity = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

// Which repo types each specialist runs on
export const SPECIALIST_REGISTRY = {
  'start-script': ['all'],
  'build-step': ['all'],
  'lockfile': ['all'],
  'dynamic-port': [RepoType.DEPLOYABLE, RepoType.SERVER, RepoType.FRAMEWORK],
  'host-binding': [RepoType.DEPLOYABLE, RepoType.SERVER, RepoType.FRAMEWORK],
  'health-check': [RepoType.DEPLOYABLE, RepoType.SERVER, RepoType.FRAMEWORK],
  'cors': [RepoType.DEPLOYABLE, RepoType.SERVER, RepoType.FRAMEWORK],
  'static-files': [RepoType.DEPLOYABLE, RepoType.SERVER, RepoType.FRAMEWORK],
  'secrets': ['all'],
  'env-vars': ['all'],
  'node-version': ['all'],
  'database-config': [RepoType.DEPLOYABLE, RepoType.SERVER, RepoType.FRAMEWORK],
  'package-manager': ['all'],
};

// Scoring weights (0-10 scale, how much each check matters)
export const WEIGHTS = {
  'start-script': 10,
  'dynamic-port': 10,
  'host-binding': 10,
  'build-step': 8,
  'health-check': 5,
  'secrets': 10,
  'env-vars': 5,
  'lockfile': 3,
  'node-version': 3,
  'database-config': 3,
  'cors': 3,
  'static-files': 2,
  'package-manager': 1,
};

// Validate that a specialist result follows the contract
export function validateResult(result) {
  const requiredFields = ['checkId', 'status', 'confidence', 'message', 'findings'];
  const missing = requiredFields.filter(f => !(f in result));
  if (missing.length > 0) {
    return { valid: false, error: `Missing fields: ${missing.join(', ')}` };
  }
  const validStatuses = Object.values(Status);
  if (!validStatuses.includes(result.status)) {
    return { valid: false, error: `Invalid status "${result.status}". Must be: ${validStatuses.join(', ')}` };
  }
  const validConfidences = Object.values(Confidence);
  if (!validConfidences.includes(result.confidence)) {
    return { valid: false, error: `Invalid confidence "${result.confidence}". Must be: ${validConfidences.join(', ')}` };
  }
  if (!Array.isArray(result.findings)) {
    return { valid: false, error: '"findings" must be an array' };
  }
  return { valid: true };
}

// Should this specialist run for this repo type?
export function shouldRun(checkId, repoType) {
  const appliesTo = SPECIALIST_REGISTRY[checkId];
  if (!appliesTo) return true; // unknown specialist — let it run
  return appliesTo.includes('all') || appliesTo.includes(repoType);
}
