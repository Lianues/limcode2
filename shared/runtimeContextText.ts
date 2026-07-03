export function stripInitialWorkEnvironmentSection(text: string): string {
  if (!text.includes('Initial work environment')) return text;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed.startsWith('Initial work environment:')) {
      result.push(line);
      continue;
    }

    const inlineValue = trimmed.slice('Initial work environment:'.length).trim();
    if (inlineValue) continue;

    while (index + 1 < lines.length && shouldStripWorkEnvironmentLine(lines[index + 1])) {
      index += 1;
    }
  }

  return result
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shouldStripWorkEnvironmentLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (looksLikeBracketHeader(trimmed)) return false;
  if (looksLikeRuntimeSectionHeader(trimmed)) return false;
  return true;
}

function looksLikeBracketHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']');
}

function looksLikeRuntimeSectionHeader(line: string): boolean {
  return /:$/.test(line) && !line.includes(' · ');
}
