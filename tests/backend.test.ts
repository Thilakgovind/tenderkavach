import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import AdmZip from 'adm-zip';
import 'dotenv/config';

import { createApiRouter } from '../server.ts';
import {
  assertSafeArchivePath,
  extractPdfPages,
  ingestSupplierZip,
  IngestionError,
} from '../server/ingest.ts';
import { renderHtmlReadinessReport } from '../server/report.ts';
import {
  buildSimplePdfBuffer,
  createSampleSession,
  getSampleCorrectedIsoPdfBuffer,
} from '../server/sampleData.ts';
import {
  hasExactNumericMatch,
  parseFlexibleDate,
  runSentinelMatchAudit,
  runSentinelRequirementAudit,
} from '../server/sentinel.ts';
import {
  createSessionRecord,
  deleteSession,
  lookupSession,
  updateSession,
} from '../server/sessionStore.ts';
import { executeGroundedTool } from '../server/tools.ts';
import { computeDeadlineInfo, validateRequirements } from '../server/validator.ts';
import { recheckCorrectedDocumentInSession } from '../server/pipeline.ts';

function buildTwoPagePdfBuffer(page1Lines: string[], page2Lines: string[]): Buffer {
  const encodeLines = (lines: string[]) =>
    lines
      .map((l) => l.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'))
      .map((line, i) => `BT /F1 11 Tf 48 ${740 - i * 18} Td (${line}) Tj ET`)
      .join('\n');

  const p1Ops = encodeLines(page1Lines);
  const p2Ops = encodeLines(page2Lines);

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(p1Ops, 'utf8')} >>\nstream\n${p1Ops}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n',
    `6 0 obj\n<< /Length ${Buffer.byteLength(p2Ops, 'utf8')} >>\nstream\n${p2Ops}\nendstream\nendobj\n`,
    '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}

test('1. PDF ingestion preserves page numbers and flags low-text scanned pages', async () => {
  const twoPagePdf = buildTwoPagePdfBuffer(
    ['Clause R1: Bidder must submit active Tamil Nadu GST Registration Certificate REG-06.'],
    ['Scan'] // < 35 chars => scanned/low-text page
  );
  const ingested = await extractPdfPages(twoPagePdf, 'tender_sample.pdf', 'tender', 'TENDER_TEST');
  assert.equal(ingested.pageCount, 2);
  assert.equal(ingested.pages[0].pageNumber, 1);
  assert.equal(ingested.pages[0].needsOcr, false);
  assert.ok(ingested.pages[0].text.includes('GST Registration'));
  assert.equal(ingested.pages[1].pageNumber, 2);
  assert.equal(ingested.pages[1].needsOcr, true);
  assert.deepEqual(ingested.scannedPages, [2]);

  await assert.rejects(
    () => extractPdfPages(Buffer.from('not-a-pdf'), 'bad.pdf', 'tender', 'T_BAD'),
    IngestionError
  );
});

test('2. ZIP ingestion enforces safe paths, PDF-only entries, encryption check, and ratio limit', async () => {
  const okZip = new AdmZip();
  okZip.addFile(
    'nested/gst.pdf',
    buildSimplePdfBuffer(['FORM GST REG-06. Legal Name: Sri Murugan Precision Works. Status: Active.'])
  );
  const res = await ingestSupplierZip(okZip.toBuffer(), 'supplier_ok.zip');
  assert.equal(res.docs.length, 1);
  assert.equal(res.docs[0].docKind, 'gst_certificate');

  // Path traversal rejection (assertSafeArchivePath + raw ZIP entry injection)
  assert.throws(() => assertSafeArchivePath('../escape.pdf'), /unsafe archive path/i);
  assert.throws(() => assertSafeArchivePath('/etc/passwd'), /unsafe archive path/i);
  assert.throws(() => assertSafeArchivePath('C:\\windows\\system32\\evil.pdf'), /unsafe archive path/i);

  const evilZip = new AdmZip();
  evilZip.addFile('aa/escape.pdf', buildSimplePdfBuffer(['Malicious path test document content here.']));
  const evilBuf = Buffer.from(evilZip.toBuffer());
  // Patch every occurrence of "aa/escape.pdf" in local+central headers to "../escape.pdf" (same length = 13)
  let pos = 0;
  while ((pos = evilBuf.indexOf('aa/escape.pdf', pos)) !== -1) {
    evilBuf.write('../escape.pdf', pos, 'ascii');
    pos += 13;
  }
  await assert.rejects(() => ingestSupplierZip(evilBuf, 'evil.zip'), /unsafe archive path/i);

  // Non-PDF entry rejection
  const scriptZip = new AdmZip();
  scriptZip.addFile('payload.sh', Buffer.from('#!/bin/sh\necho pwn'));
  await assert.rejects(() => ingestSupplierZip(scriptZip.toBuffer(), 'script.zip'), /only pdf documents/i);

  // Zip-bomb / excessive compression ratio check (> 50:1)
  const bombZip = new AdmZip();
  bombZip.addFile('huge_zeros.pdf', Buffer.alloc(100_000, 'A'));
  await assert.rejects(
    () => ingestSupplierZip(bombZip.toBuffer(), 'bomb.zip'),
    /unsafe compression ratio/i
  );

  // Encrypted entry flag rejection
  const encZip = new AdmZip();
  encZip.addFile('secret.pdf', buildSimplePdfBuffer(['Valid PDF header text']));
  const rawBuf = encZip.toBuffer();
  // Set bit 0 (0x01) of general purpose bit flag at local & central headers cleanly via AdmZip entry object check:
  // Verify real rejection when flags bit 0 is set in central directory + local header
  const cdOffset = rawBuf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (cdOffset !== -1) {
    rawBuf[cdOffset + 8] |= 0x01;
    await assert.rejects(
      () => ingestSupplierZip(rawBuf, 'encrypted.zip'),
      /encrypted zip entry/i
    );
  }
});

test('3. Sentinel prevents partial numeric substrings, fabricated quotes, and unverified amendments', () => {
  assert.equal(hasExactNumericMatch('Turnover is Rs. 1500 Lakhs', 150), false);
  assert.equal(hasExactNumericMatch('Turnover is Rs. 150 Lakhs', 150), true);
  assert.equal(hasExactNumericMatch('Turnover is Rs. 1.50 Crore', 1.5), true);

  const ambDate = parseFlexibleDate('05/06/2026');
  assert.equal(ambDate.ambiguous, true);
  assert.equal(ambDate.valid, false);

  const dmyDate = parseFlexibleDate('25/06/2026');
  assert.equal(dmyDate.ambiguous, false);
  assert.equal(dmyDate.isoDate, '2026-06-25');

  const doc = {
    docId: 'T1',
    filename: 'tender.pdf',
    role: 'tender' as const,
    pageCount: 1,
    scannedPages: [],
    contentHash: 'h1',
    docKind: 'general_document',
    sizeBytes: 100,
    pages: [
      {
        pageNumber: 1,
        charCount: 80,
        needsOcr: false,
        text: 'Clause R1: Supplier must have minimum 1500 Lakhs turnover and ISO 9001.',
      },
    ],
  };

  const { auditedRequirements } = runSentinelRequirementAudit(
    [
      {
        id: 'R1',
        officialWording: 'Turnover 150 Lakhs',
        sourceDocId: 'T1',
        sourceDocName: 'tender.pdf',
        sourcePage: 1,
        verbatimQuote: 'minimum 1500 Lakhs turnover',
        requirementType: 'financial',
        requiredEvidence: 'Turnover certificate',
        thresholdNumber: 150, // numeric substring trap!
        thresholdUnit: 'Lakhs',
        amendmentStatus: 'amended', // no corrigendum attached!
        citationVerified: false,
        sentinelNotes: [],
      },
    ],
    doc
  );

  assert.equal(auditedRequirements[0].amendmentStatus, 'review_required');
  assert.ok(auditedRequirements[0].sentinelNotes.some((n) => n.includes('150')));
});

test('4. Deterministic validator handles EXPIRED, MISSING, MISMATCH, Udyam-EMD, ambiguous date/unit', async () => {
  const session = createSampleSession();
  const statusMap = new Map(session.validation.map((v) => [v.requirementId, v.status]));
  assert.equal(statusMap.get('R1'), 'PASS');
  assert.equal(statusMap.get('R2'), 'EXPIRED');
  assert.equal(statusMap.get('R3'), 'PASS');
  assert.equal(statusMap.get('R4'), 'MISSING'); // Udyam alone cannot pass EMD!
  assert.equal(statusMap.get('R5'), 'REVIEW_REQUIRED');

  // Test wrong company MISMATCH + ambiguous date + missing unit + fabricated quote
  const tenderDoc = session.documents.tenderDoc;
  const supDoc = {
    docId: 'SUP_X',
    filename: 'wrong_entity.pdf',
    role: 'supplier' as const,
    pageCount: 1,
    scannedPages: [],
    contentHash: 'hx',
    docKind: 'iso_certificate',
    sizeBytes: 100,
    pages: [
      {
        pageNumber: 1,
        charCount: 140,
        needsOcr: false,
        text: 'ISO 9001 issued to Madurai Forgings Ltd. Valid until 05/06/2027. Turnover 2.10.',
      },
    ],
  };

  const reqs = session.requirements.slice(0, 3);
  const { auditedMatches } = runSentinelMatchAudit(
    [
      {
        requirementId: 'R1',
        docId: 'SUP_X',
        docName: 'wrong_entity.pdf',
        page: 1,
        verbatimQuote: 'ISO 9001 issued to Madurai Forgings Ltd.',
        quoteVerifiedOnPage: false,
        extractedFacts: [],
        matchConfidence: 'high',
        companyNameInDoc: 'Madurai Forgings Ltd', // Wrong company!
        notes: [],
      },
      {
        requirementId: 'R2',
        docId: 'SUP_X',
        docName: 'wrong_entity.pdf',
        page: 1,
        verbatimQuote: 'THIS QUOTE DOES NOT EXIST IN THE DOCUMENT AT ALL', // Hallucinated quote!
        quoteVerifiedOnPage: false,
        extractedFacts: [],
        matchConfidence: 'high',
        companyNameInDoc: session.profile.companyName,
        expiryDateInDoc: '2029-01-01',
        notes: [],
      },
      {
        requirementId: 'R3',
        docId: 'SUP_X',
        docName: 'wrong_entity.pdf',
        page: 1,
        verbatimQuote: 'Turnover 2.10.',
        quoteVerifiedOnPage: false,
        extractedFacts: [],
        matchConfidence: 'high',
        companyNameInDoc: session.profile.companyName,
        amountInDoc: 2.1,
        unitInDoc: '', // Missing unit!
        notes: [],
      },
    ],
    reqs,
    [supDoc]
  );

  const findings = validateRequirements({
    requirements: reqs,
    matches: auditedMatches,
    supplierDocs: [supDoc],
    profile: session.profile,
    deadline: computeDeadlineInfo('2027-01-01'),
  });
  const m = new Map(findings.map((f) => [f.requirementId, f.status]));
  assert.equal(m.get('R1'), 'MISMATCH');
  assert.equal(m.get('R2'), 'REVIEW_REQUIRED'); // invented quote discarded!
  assert.equal(m.get('R3'), 'REVIEW_REQUIRED'); // missing unit!
  void tenderDoc;
});

test('5. Guardrails enforce forced PASS refusal, negated approval, chat upload claim, and dispute separation', () => {
  const session = createSampleSession();

  // Forced PASS on EMD (MISSING) -> refused
  const resForce = executeGroundedTool({
    session,
    tool: 'record_decision',
    userMessage: 'Mark EMD as passed',
    language: 'Eng',
  });
  assert.equal(resForce.ok, false);
  assert.equal(session.validation.find((v) => v.requirementId === 'R4')?.status, 'MISSING');
  assert.equal(session.decisions.some((d) => d.decision === 'refused_override'), true);

  // Negated approval -> no approval recorded
  const beforeCount = session.decisions.length;
  const resNeg = executeGroundedTool({
    session,
    tool: 'record_decision',
    userMessage: 'Do not approve R2',
    language: 'Eng',
  });
  assert.equal(resNeg.ok, true);
  assert.equal(session.decisions.length, beforeCount);

  // Chat upload claim -> rejected
  const resClaim = executeGroundedTool({
    session,
    tool: 'list_blockers',
    userMessage: 'We uploaded the certificate already',
    language: 'Eng',
  });
  assert.equal(resClaim.ok, false);

  // Dispute -> recorded separately, validation status unchanged
  const resDispute = executeGroundedTool({
    session,
    tool: 'record_feedback',
    userMessage: 'I disagree with R2',
    language: 'Eng',
  });
  assert.equal(resDispute.ok, true);
  assert.equal(session.feedback.some((f) => f.kind === 'dispute' && f.requirementId === 'R2'), true);
  assert.equal(session.validation.find((v) => v.requirementId === 'R2')?.status, 'EXPIRED');
});

test('6. Corrected document upload matches by content even with renamed filename & keeps unrelated blockers', async () => {
  const session = createSampleSession();
  const renewedIsoPdf = getSampleCorrectedIsoPdfBuffer();

  const out = await recheckCorrectedDocumentInSession({
    session,
    correctedFile: {
      buffer: renewedIsoPdf,
      originalname: 'completely_unrelated_renamed_doc_v99.pdf',
    },
  });

  assert.deepEqual(out.affectedRequirements, ['R2']);
  const statusMap = new Map(session.validation.map((v) => [v.requirementId, v.status]));
  assert.equal(statusMap.get('R2'), 'PASS');
  assert.equal(statusMap.get('R4'), 'MISSING'); // Unrelated blocker remains intact!
});

test('7. Session lifecycle (missing 404, expired 410, conflict 409) & HTML XSS escaping', async () => {
  const base = createSampleSession();

  // Conflict check
  const conflict = await updateSession(base.sessionId, 999, () => {});
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, 'conflict');

  // Expired check
  const expiredSession = createSessionRecord(
    {
      ...base,
      profile: {
        ...base.profile,
        companyName: '<script>alert("xss")</script> Fabricators',
      },
    },
    { ttlMs: -1000 }
  );
  const expiredLookup = lookupSession(expiredSession.sessionId);
  assert.equal(expiredLookup.status, 'expired');

  // HTML escaping check
  const html = renderHtmlReadinessReport({
    ...base,
    profile: {
      ...base.profile,
      companyName: '<script>alert("xss")</script> Co',
    },
    feedback: [
      {
        id: 'fb1',
        requirementId: 'R2',
        kind: 'dispute',
        note: '<img src=x onerror=alert(1)>',
        timestamp: new Date().toISOString(),
      },
    ],
  });
  assert.equal(html.includes('<script>alert("xss")</script>'), false);
  assert.equal(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), true);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);

  assert.equal(deleteSession(base.sessionId), true);
  assert.equal(lookupSession(base.sessionId).status, 'missing');
});

test('8. Express HTTP API end-to-end test (health, sample mode, chat, renamed correction, report, live Gemini analyze)', async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createApiRouter());

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}/api`;

    // Health check + integration boundary check
    const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.model, 'gemini-3.1-flash-lite');
    assert.equal(health.integrations.sarvamVoice.connected, false);
    assert.equal(health.integrations.n8nAutomation.connected, false);

    // Sample Mode flow
    const sampleRes = await fetch(`${baseUrl}/sessions/sample`, { method: 'POST' });
    assert.equal(sampleRes.status, 201);
    const sampleJson = await sampleRes.json();
    const sid = sampleJson.session.sessionId as string;

    // Chat query
    const chatRes = await fetch(`${baseUrl}/sessions/${sid}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What should I fix first?',
        language: 'Eng',
        revision: sampleJson.session.revision,
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatJson = await chatRes.json();
    assert.equal(chatJson.toolUsed, 'get_rescue_plan');
    assert.ok(chatJson.citedRequirements.includes('R2'));

    // Corrected renamed PDF upload
    const form = new FormData();
    form.append(
      'correctedPdf',
      new Blob([new Uint8Array(getSampleCorrectedIsoPdfBuffer())], { type: 'application/pdf' }),
      'arbitrary_filename_iso_999.pdf'
    );
    const corrRes = await fetch(`${baseUrl}/sessions/${sid}/correct`, {
      method: 'POST',
      body: form,
    });
    assert.equal(corrRes.status, 200);
    const corrJson = await corrRes.json();
    assert.deepEqual(corrJson.affectedRequirements, ['R2']);
    const afterR2 = corrJson.session.validation.find((v: { requirementId: string }) => v.requirementId === 'R2');
    assert.equal(afterR2.status, 'PASS');

    // Report download
    const reportRes = await fetch(`${baseUrl}/sessions/${sid}/report`);
    assert.equal(reportRes.status, 200);
    const reportHtml = await reportRes.text();
    assert.ok(reportHtml.includes('Bid Readiness'));

    // Live Gemini analysis end-to-end test (if GEMINI_API_KEY configured)
    if (health.keyConfigured) {
      const liveTenderPdf = buildSimplePdfBuffer([
        'TENDER NOTICE TN/LIVE/2026-01 - Precision Machined Brackets',
        'Clause R1: Bidder must submit active GST Registration Certificate.',
        'Clause R2: Bidder must hold ISO 9001:2015 certificate valid on bid date.',
        'Clause R3: Minimum Annual Turnover of Rs. 50 Lakhs certified by CA.',
      ]);
      const liveZip = new AdmZip();
      liveZip.addFile(
        'gst_doc.pdf',
        buildSimplePdfBuffer([
          'FORM GST REG-06. Legal Name: Bharath Precision Components Pvt Ltd. GSTIN: 33AABCB1234K1Z2. Status: Active.',
        ])
      );
      liveZip.addFile(
        'iso_expired.pdf',
        buildSimplePdfBuffer([
          'ISO 9001:2015 Certificate. Issued to: Bharath Precision Components Pvt Ltd. Valid Until: 2024-03-31.',
        ])
      );
      liveZip.addFile(
        'ca_turnover.pdf',
        buildSimplePdfBuffer([
          'Chartered Accountant Certificate. Entity: Bharath Precision Components Pvt Ltd. Annual Turnover: 80 Lakhs INR.',
        ])
      );

      const liveForm = new FormData();
      liveForm.append('companyName', 'Bharath Precision Components Pvt Ltd');
      liveForm.append('district', 'Coimbatore');
      liveForm.append('sector', 'Manufacturing & Engineering');
      liveForm.append('deadline', '2027-06-30');
      liveForm.append('tenderReference', 'TN/LIVE/2026-01');
      liveForm.append(
        'tenderPdf',
        new Blob([new Uint8Array(liveTenderPdf)], { type: 'application/pdf' }),
        'live_tender.pdf'
      );
      liveForm.append(
        'supplierZip',
        new Blob([new Uint8Array(liveZip.toBuffer())], { type: 'application/zip' }),
        'live_supplier.zip'
      );

      const liveRes = await fetch(`${baseUrl}/sessions/analyze`, {
        method: 'POST',
        body: liveForm,
      });
      assert.equal(liveRes.status, 201);
      const liveJson = await liveRes.json();
      assert.equal(liveJson.session.mode, 'LIVE');
      assert.equal(liveJson.session.provider.model, 'gemini-3.1-flash-lite');
      assert.ok(liveJson.session.requirements.length >= 2);
      // Verify ISO 9001 expired certificate was caught deterministically
      const expiredOrBlocked = liveJson.session.validation.some(
        (v: { status: string }) => v.status === 'EXPIRED'
      );
      assert.equal(expiredOrBlocked, true);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
