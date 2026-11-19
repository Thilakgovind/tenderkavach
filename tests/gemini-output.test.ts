import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRequirementsOutput, parseEvidenceOutput, parseToolOutput } from '../server/geminiOutput.ts';

test('requirements output rejects malformed model replies', () => {
  assert.deepEqual(parseRequirementsOutput('{"requirements":[]}').requirements, []);
  for (const raw of ['', '{}', '{"requirements":{}}', '{"requirements":[null]}']) {
    assert.throws(() => parseRequirementsOutput(raw), /INVALID_REQUIREMENTS_RESPONSE/);
  }
});

test('evidence output rejects malformed model replies', () => {
  assert.deepEqual(parseEvidenceOutput('{"matches":[]}').matches, []);
  for (const raw of ['', '{}', '{"matches":{}}', '{"matches":[null]}']) {
    assert.throws(() => parseEvidenceOutput(raw), /INVALID_MATCHES_RESPONSE/);
  }
});

test('tool selection rejects malformed model replies', () => {
  assert.equal(parseToolOutput('{"tool":"list_blockers"}').tool, 'list_blockers');
  for (const raw of ['', '{}', '{"tool":4}', '{"tool":"list_blockers","note":4}']) {
    assert.throws(() => parseToolOutput(raw), /INVALID_TOOL_SELECTION_RESPONSE/);
  }
});
