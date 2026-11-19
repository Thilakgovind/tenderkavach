function invalid(stage: string): never {
  throw new Error(`INVALID_JSON_SCHEMA: ${stage} response from Gemini is invalid.`);
}

function record(value: unknown, stage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(stage);
  return value as Record<string, unknown>;
}

function parse(raw: string, stage: string): Record<string, unknown> {
  try { return record(JSON.parse(raw) as unknown, stage); }
  catch { return invalid(stage); }
}

export function parseRequirementsOutput(raw: string): {
  requirements: Array<Record<string, unknown>>;
  incompleteCoverageWarning?: string;
} {
  const data = parse(raw, 'Requirements');
  if (!Array.isArray(data.requirements) || data.requirements.some(item =>
    !item || typeof item !== 'object' || Array.isArray(item))) invalid('Requirements');
  if (data.incompleteCoverageWarning !== undefined && typeof data.incompleteCoverageWarning !== 'string') invalid('Requirements');
  return data as { requirements: Array<Record<string, unknown>>; incompleteCoverageWarning?: string };
}

export function parseEvidenceOutput(raw: string): { matches: Array<Record<string, unknown>> } {
  const data = parse(raw, 'Matches');
  if (!Array.isArray(data.matches) || data.matches.some(item =>
    !item || typeof item !== 'object' || Array.isArray(item))) invalid('Matches');
  return data as { matches: Array<Record<string, unknown>> };
}

export function parseToolOutput(raw: string): Record<string, unknown> {
  const data = parse(raw, 'Tool selection');
  if (typeof data.tool !== 'string') invalid('Tool selection');
  for (const key of ['requirementId', 'decision', 'note']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') invalid('Tool selection');
  }
  return data;
}
