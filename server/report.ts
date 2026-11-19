import type { SessionState } from './types.ts';

export function escapeHtml(input: unknown): string {
  const str = String(input ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHtmlReadinessReport(session: SessionState): string {
  const valMap = new Map(session.validation.map((v) => [v.requirementId, v]));
  const matchMap = new Map(session.matches.map((m) => [m.requirementId, m]));

  const unresolved = session.validation.filter(
    (v) => v.status !== 'PASS' && v.status !== 'NOT_APPLICABLE'
  );

  const reqRows = session.requirements
    .map((req) => {
      const finding = valMap.get(req.id);
      const match = matchMap.get(req.id);
      const status = finding?.status ?? 'REVIEW_REQUIRED';
      const evidenceRef = match?.docId
        ? `${escapeHtml(match.docName)} (p.${escapeHtml(match.page)})`
        : 'None matched';
      const evidenceQuote = match?.verbatimQuote
        ? `<blockquote>${escapeHtml(match.verbatimQuote)}</blockquote>`
        : '';

      return `
      <tr>
        <td><strong>${escapeHtml(req.id)}</strong><br><small>${escapeHtml(req.requirementType)}</small></td>
        <td>
          <div>${escapeHtml(req.officialWording)}</div>
          <small>Source: ${escapeHtml(req.sourceDocName)} p.${escapeHtml(req.sourcePage)} ${
            req.citationVerified ? '(Citation verified)' : '(UNVERIFIED CITATION)'
          }</small>
          <blockquote>${escapeHtml(req.verbatimQuote)}</blockquote>
        </td>
        <td>
          <div>${evidenceRef}</div>
          ${evidenceQuote}
        </td>
        <td><span class="status status-${escapeHtml(status)}">${escapeHtml(status)}</span></td>
        <td>${escapeHtml(finding?.explanation || '')}</td>
      </tr>`;
    })
    .join('\n');

  const rescueRows = session.plan.length
    ? session.plan
        .map(
          (p) => `
      <tr>
        <td>#${escapeHtml(p.priority)} · ${escapeHtml(p.urgency)}</td>
        <td><strong>${escapeHtml(p.requirementId)}</strong></td>
        <td>${escapeHtml(p.whatToFix)}<br><small>Required: ${escapeHtml(p.requiredEvidence)}</small></td>
        <td>${escapeHtml(p.suggestedOwner)}</td>
        <td>${escapeHtml(p.timeRemaining)}<br><small>Feasibility: ${escapeHtml(p.feasibility)} — ${escapeHtml(p.leadTimeNote)}</small></td>
      </tr>`
        )
        .join('\n')
    : '<tr><td colspan="5">No unresolved rescue actions remain.</td></tr>';

  const disputeItems = session.feedback
    .map(
      (f) =>
        `<li><strong>${escapeHtml(f.kind.toUpperCase())}</strong> ${
          f.requirementId ? `(${escapeHtml(f.requirementId)})` : ''
        } · ${escapeHtml(f.timestamp)}: ${escapeHtml(f.note)}</li>`
    )
    .join('\n');

  const decisionItems = session.decisions
    .map(
      (d) =>
        `<li><strong>${escapeHtml(d.decision)}</strong> on ${escapeHtml(d.requirementId)} · ${escapeHtml(
          d.timestamp
        )}: ${escapeHtml(d.actorNote)} ${
          d.blockedReason ? `<em>[Blocked: ${escapeHtml(d.blockedReason)}]</em>` : ''
        }</li>`
    )
    .join('\n');

  const warningItems = session.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('\n');

  const auditRows = session.audit_events
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.timestamp)}</td><td>${escapeHtml(a.actor)}</td><td>${escapeHtml(
          a.action
        )}</td><td>${escapeHtml(a.requirementId || '-')}</td><td>${escapeHtml(a.detail)}</td></tr>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Namma Tender Bid Readiness Report — ${escapeHtml(session.profile.companyName)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #18181b; max-width: 1080px; margin: 32px auto; padding: 0 20px; line-height: 1.5; }
    h1, h2 { color: #111827; margin-top: 28px; }
    .banner { background: #14111f; color: #fff; padding: 20px 24px; border-radius: 12px; border-left: 6px solid #e0a458; }
    .banner small { color: #e0a458; text-transform: uppercase; letter-spacing: 0.12em; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 18px 0; background: #f8fafc; padding: 14px; border-radius: 8px; border: 1px solid #e2e8f0; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; }
    blockquote { margin: 6px 0 0; padding: 6px 10px; background: #f8fafc; border-left: 3px solid #94a3b8; font-size: 12px; color: #334155; }
    .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 700; font-size: 11px; }
    .status-PASS { background: #dcfce7; color: #166534; }
    .status-EXPIRED, .status-FAIL, .status-MISSING, .status-MISMATCH { background: #fee2e2; color: #991b1b; }
    .status-REVIEW_REQUIRED { background: #fef3c7; color: #92400e; }
    .notice { background: #fffbeb; border: 1px solid #fcd34d; padding: 12px 16px; border-radius: 8px; margin-top: 16px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="banner">
    <small>Namma Tender · ${escapeHtml(session.mode)} MODE REPORT (Revision v${escapeHtml(session.revision)})</small>
    <h1 style="color:#fff;margin:6px 0 0;">Bid Readiness &amp; Rescue Dossier</h1>
  </div>

  <div class="meta">
    <div><strong>Company:</strong><br>${escapeHtml(session.profile.companyName)}</div>
    <div><strong>District &amp; Sector:</strong><br>${escapeHtml(session.profile.district)} · ${escapeHtml(session.profile.sector)}</div>
    <div><strong>Tender Reference:</strong><br>${escapeHtml(session.profile.tenderReference || 'Not specified')}</div>
    <div><strong>Confirmed Deadline:</strong><br>${escapeHtml(session.deadline.confirmedDate)} (${escapeHtml(session.deadline.timeRemainingText)})</div>
    <div><strong>Provider / Extraction:</strong><br>${escapeHtml(session.provider.provider)} (${escapeHtml(session.provider.model)} · ${escapeHtml(session.provider.extractionMode)})</div>
    <div><strong>Unresolved Findings:</strong><br>${escapeHtml(unresolved.length)} of ${escapeHtml(session.requirements.length)} requirements</div>
  </div>

  <div class="notice">
    <strong>Important Limitations:</strong> Namma Tender checks supplied documents for evidence gaps and formatting/expiry risks.
    It does <strong>not</strong> guarantee bid acceptance, winning probability, or legal eligibility. External renewal lead times marked "unknown" are unverified.
  </div>

  <h2>1. Requirements &amp; Validation Findings</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Official Requirement &amp; Tender Source</th>
        <th>Matched Supplier Evidence</th>
        <th>Status</th>
        <th>Explanation</th>
      </tr>
    </thead>
    <tbody>
      ${reqRows}
    </tbody>
  </table>

  <h2>2. Bid Rescue Action Plan</h2>
  <table>
    <thead>
      <tr>
        <th>Priority</th>
        <th>Req</th>
        <th>Corrective Action</th>
        <th>Suggested Owner</th>
        <th>Time Remaining &amp; Feasibility</th>
      </tr>
    </thead>
    <tbody>
      ${rescueRows}
    </tbody>
  </table>

  <h2>3. Sentinel Warnings &amp; Coverage Limitations</h2>
  <ul>${warningItems || '<li>No Sentinel warnings recorded.</li>'}</ul>

  <h2>4. Human Decisions &amp; Disputes (Kept Separate from Validation Status)</h2>
  <h3>Human Decisions</h3>
  <ul>${decisionItems || '<li>No human decisions recorded.</li>'}</ul>
  <h3>Disputes &amp; Feedback</h3>
  <ul>${disputeItems || '<li>No disputes or feedback recorded.</li>'}</ul>

  <h2>5. Audit Trail</h2>
  <table>
    <thead>
      <tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Req</th><th>Detail</th></tr>
    </thead>
    <tbody>
      ${auditRows}
    </tbody>
  </table>
</body>
</html>`;
}
