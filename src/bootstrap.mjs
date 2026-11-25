import { bootstrapTokenBudget } from './config.mjs';
import {
  MEMORY_CATEGORIES, recordAccess, resolveCachedProjectKey, selectMemories, selectNotes,
} from './memory-service.mjs';

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function escapeXml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function onOneLine(text) {
  return escapeXml(text.trim().replace(/\s+/gu, ' '));
}

function section(opening, closing, items, label) {
  const omittedLine = (count) => count ? `… ${count} ${label} omitted.\n` : '';
  const wrapperLength = opening.length + closing.length;
  let fullLength = wrapperLength;
  const headings = new Set();
  for (const { heading, line } of items) {
    fullLength += line.length;
    if (heading && !headings.has(heading)) {
      fullLength += heading.length + 1;
      headings.add(heading);
    }
  }

  return {
    minimumLength: Math.min(fullLength, wrapperLength + omittedLine(items.length).length),
    render(budget) {
      let used = wrapperLength;
      const included = [];
      const groups = new Map();
      for (const { id, heading, line } of items) {
        const headingLength = heading && !groups.has(heading) ? heading.length + 1 : 0;
        const nextLength = used + headingLength + line.length;
        if (fullLength > budget && nextLength + omittedLine(items.length - included.length - 1).length > budget) {
          continue;
        }
        if (!groups.has(heading)) groups.set(heading, []);
        groups.get(heading).push(line);
        used = nextLength;
        included.push(id);
      }
      const lines = [];
      for (const heading of [...MEMORY_CATEGORIES.map((category) => `### ${category}`), '']) {
        const group = groups.get(heading);
        if (!group) continue;
        if (heading) lines.push(`${heading}\n`);
        lines.push(group.join(''));
      }
      lines.push(omittedLine(items.length - included.length));
      return { text: opening + lines.join('') + closing, included };
    },
  };
}

export function formatBootstrap(db, options = {}) {
  const { cwd, defaultCwd, includeNotes = true, config } = options;
  const { projectKey, displayName } = options.project ?? resolveCachedProjectKey(cwd ?? defaultCwd, config);
  const tokenBudget = options.tokenBudget ?? bootstrapTokenBudget(config, projectKey);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) {
    throw new Error('token budget must be a positive integer');
  }
  const memories = selectMemories(db, { projectKey, scope: 'all', status: 'active' });
  const notes = includeNotes === false ? [] : selectNotes(db, { projectKey });
  const memorySection = section(
    `<project-memory project="${escapeXml(displayName)}" key="${escapeXml(projectKey)}">\n`,
    '</project-memory>',
    memories.map(({ id, category, content }) => ({ id, heading: `### ${category}`, line: `- ${onOneLine(content)}\n` })),
    'memories',
  );
  const noteSection = notes.length ? section(
    '<active-notes>\n',
    '</active-notes>',
    notes.map(({ id, content, status, surface_condition }) => {
      const condition = surface_condition ? ` (surface when: ${onOneLine(surface_condition)})` : '';
      return { id, heading: '', line: `- [${status}] ${onOneLine(content)}${condition}\n` };
    }),
    'notes',
  ) : null;

  const characterBudget = tokenBudget * 4;
  const noteReserve = noteSection ? noteSection.minimumLength + 1 : 0;
  const requiredMinLength = memorySection.minimumLength + noteReserve;
  if (characterBudget < requiredMinLength) {
    throw new Error(`token_budget (${tokenBudget}) is too small to render bootstrap summary; minimum required is ${Math.ceil(requiredMinLength / 4)} tokens`);
  }

  const renderedMemories = memorySection.render(characterBudget - noteReserve);
  let text = renderedMemories.text;
  let includedNotes = [];
  if (noteSection) {
    const noteBudget = characterBudget - text.length - 1;
    const renderedNotes = noteSection.render(noteBudget);
    text += `\n${renderedNotes.text}`;
    includedNotes = renderedNotes.included;
  }
  if (options.recordAccess === true) {
    recordAccess(db, { memories: renderedMemories.included, notes: includedNotes });
  }
  return {
    text, projectKey, displayName,
    includedMemories: renderedMemories.included.length,
    omittedMemories: memories.length - renderedMemories.included.length,
    includedNotes: includedNotes.length,
    omittedNotes: notes.length - includedNotes.length,
    estimatedTokens: estimateTokens(text),
    tokenBudget,
  };
}
