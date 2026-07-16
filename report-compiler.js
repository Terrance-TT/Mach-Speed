// report-compiler.js — Aggregates specialist results into a scorecard

import { Status, WEIGHTS } from './contract.js';

export function compileReport(results, repoType, owner, repo) {
  let totalWeight = 0;
  let earnedWeight = 0;
  const checks = [];

  for (const result of results) {
    const weight = WEIGHTS[result.checkId] || 1;
    let points = 0;
    switch (result.status) {
      case Status.PASS: points = weight; break;
      case Status.FAIL: points = 0; break;
      case Status.CHECK_IT: points = weight * 0.5; break;
      case Status.NOT_APPLICABLE: points = weight; break;
    }
    totalWeight += weight;
    earnedWeight += points;
    checks.push({
      id: result.checkId,
      name: result.name || result.checkId,
      status: result.status,
      confidence: result.confidence,
      message: result.message,
      findings: result.findings || [],
      weight,
    });
  }

  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 10) : 0;
  const passed = checks.filter(c => c.status === Status.PASS).length;
  const failed = checks.filter(c => c.status === Status.FAIL).length;
  const checkIt = checks.filter(c => c.status === Status.CHECK_IT).length;
  const na = checks.filter(c => c.status === Status.NOT_APPLICABLE).length;

  return {
    repo: `${owner}/${repo}`,
    repoType,
    score,
    summary: { passed, failed, checkIt, notApplicable: na, total: checks.length },
    checks,
    verdict: score >= 9 ? 'Excellent' : score >= 7 ? 'Good' : score >= 5 ? 'Fair' : score >= 3 ? 'Poor' : 'Critical',
  };
}
