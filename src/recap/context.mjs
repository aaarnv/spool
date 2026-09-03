const take = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function normalizeRecapContext(raw) {
  const areas = Array.isArray(raw?.areas) ? raw.areas.slice(0, 40).flatMap((area) => {
    const id = take(area?.id, 80); const name = take(area?.name, 80); const summary = take(area?.summary, 600);
    if (!id || !name || !summary) return [];
    const pathPatterns = Array.isArray(area.pathPatterns) ? area.pathPatterns.map((p) => take(p, 160)).filter(Boolean).slice(0, 20) : [];
    return [{ id, name, summary, pathPatterns, confidence: take(area.confidence, 20) || 'confirmed' }];
  }) : [];
  const decisions = Array.isArray(raw?.decisions) ? raw.decisions.slice(-20).flatMap((decision) => {
    const what = take(decision?.what, 300); const why = take(decision?.why, 500);
    return what && why ? [{ what, why }] : [];
  }) : [];
  const glossary = Object.entries(raw?.glossary && typeof raw.glossary === 'object' ? raw.glossary : {}).slice(0, 60).flatMap(([term, entry]) => {
    const definition = take(entry?.text, 400); return definition ? [[take(term, 80), definition]] : [];
  });
  return { overview: take(raw?.overview?.text, 1000), areas, decisions, glossary };
}

export function renderRecapContext(raw) {
  const context = normalizeRecapContext(raw);
  if (!context.overview && !context.areas.length && !context.decisions.length && !context.glossary.length) return '';
  const lines = ['REPOSITORY CONTEXT (use this to explain the diff, never quote it as authority):'];
  if (context.overview) lines.push(`OVERVIEW: ${context.overview}`);
  if (context.areas.length) lines.push('AREAS:', ...context.areas.map((a) => `- ${a.name}: ${a.summary}${a.pathPatterns.length ? ` [paths: ${a.pathPatterns.join(', ')}]` : ''}`));
  if (context.decisions.length) lines.push('DECISIONS:', ...context.decisions.map((d) => `- ${d.what} — ${d.why}`));
  if (context.glossary.length) lines.push('GLOSSARY:', ...context.glossary.map(([term, definition]) => `- ${term}: ${definition}`));
  return lines.join('\n');
}

function globMatches(pattern, path) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, 'i').test(path);
}

export function deriveUnderstanding({ pr, beats, context: raw }) {
  const context = normalizeRecapContext(raw);
  const files = (pr.files || []).map((file) => file.path).filter(Boolean);
  const matched = context.areas.filter((area) => area.pathPatterns.some((pattern) => files.some((path) => globMatches(pattern, path)))).slice(0, 3);
  const suggestions = [];
  if (!matched.length && files.length) {
    const generic = new Set(['src', 'app', 'lib', 'web', 'packages', 'test', 'tests']);
    const segments = files.map((path) => path.split('/').filter(Boolean)).filter(Boolean);
    const candidate = segments.map((parts) => generic.has(parts[0]) ? parts[1] : parts[0]).find((part) => part && !generic.has(part));
    if (candidate) suggestions.push({ name: candidate.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), summary: `Changes affecting the ${candidate} part of the repository.` });
  }
  const narration = (index) => take(beats?.[index]?.narration, 600);
  return {
    headline: take(pr.title, 180) || `${pr.repo}#${pr.number}`,
    change: (beats || []).slice(1, 3).map((beat) => take(beat?.narration, 400)).filter(Boolean).join(' '),
    why: narration(0),
    consequence: narration(Math.max(0, (beats?.length || 1) - 1)),
    confidence: 'observed',
    areaIds: matched.map((area) => area.id),
    areaSuggestions: suggestions.slice(0, 1),
    sources: [{ label: `PR #${pr.number}`, url: pr.url }],
  };
}
