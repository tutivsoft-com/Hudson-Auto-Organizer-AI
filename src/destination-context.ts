import { firstWords } from "./text-limits";

export interface DestinationSample { path: string; sample: string; folderPath?: string; }
export type DestinationContext = (items: Array<{ path: string; excerpt: string; sourceContext?: string }>, stopped: () => boolean) => Promise<DestinationSample[]>;

const MAX_SAMPLES = 12;
const SAMPLE_WORDS = 45;
const SAMPLE_CHARACTERS = 320;

export function sourceFileExcerpt(content: string): string {
  const words = content.trim().split(/\s+/u);
  if (words.length <= 200) return content.trim().slice(0, 1600);
  return [
    `Start: ${words.slice(0, 65).join(" ")}`,
    `Middle: ${words.slice(Math.max(0, Math.floor(words.length / 2) - 32), Math.floor(words.length / 2) + 33).join(" ")}`,
    `End: ${words.slice(-65).join(" ")}`
  ].join("\n").slice(0, 1600);
}

export function sourceLineContext(content: string, lineNumber: number): string {
  const lines = content.split(/\r?\n/u);
  const before = lines.slice(Math.max(0, lineNumber - 4), lineNumber - 1).filter((line) => line.trim()).at(-1);
  const after = lines.slice(lineNumber, lineNumber + 3).find((line) => line.trim());
  return firstWords([before, after].filter(Boolean).join(" | "), 40).slice(0, 240);
}

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((word) => word.length >= 3 && !/^\d+$/u.test(word))
    .map((word) => word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

function sampleText(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  const lines = body.split(/\r?\n/u).map((line) => line.trim()
    .replace(/^\d{14}\s+/u, "")
    .replace(/!?\[([^\]]*)\]\(https?:\/\/[^)]+\)/gu, "$1"))
    .filter((line) => line && !/^https?:\/\/\S+$/u.test(line) && !/^```/u.test(line));
  const positions = [...new Set([0, Math.floor(lines.length / 2), lines.length - 1])];
  return firstWords(positions.filter((i) => i >= 0 && i < lines.length)
    .map((i) => firstWords(lines[i], 15)).join(" | "), SAMPLE_WORDS).slice(0, SAMPLE_CHARACTERS);
}

// Cache only short samples for this planning run, never destination bodies or persistent data.
export function createDestinationContext(paths: string[], read: (path: string) => Promise<string>, folderFiles: Array<{ path: string; folderPath: string }> = []): DestinationContext {
  const examples = new Map(folderFiles.map((file) => [file.path, file.folderPath]));
  const candidates = [...new Set([...paths, ...examples.keys()])].map((path) => ({ path, folderPath: examples.get(path), words: tokens(path.replace(/\.md$/iu, "")) }));
  const cache = new Map<string, string>();
  return async (items, stopped) => {
    const ranked = items.map((item) => {
      const query = tokens(`${item.path.split("/").pop()} ${item.excerpt} ${item.sourceContext || ""}`);
      const sorted = candidates.filter((candidate) => candidate.path !== item.path)
        .map((candidate) => ({ path: candidate.path, folderPath: candidate.folderPath, score: [...candidate.words].filter((word) => query.has(word)).length
          + (/\b(notes?|general|important|scratchpad)\b/iu.test(candidate.path) ? 0.1 : 0) }))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const scopes = new Set<string>();
      return sorted.filter((candidate) => {
        const scope = candidate.folderPath || candidate.path;
        if (scopes.has(scope)) return false;
        scopes.add(scope); return true;
      }).slice(0, 3);
    });
    const selected = new Set<string>();
    // Share the budget across source items before adding second and third candidates.
    for (let rank = 0; rank < 3; rank++) for (const choices of ranked) {
      if (choices[rank] && selected.size < MAX_SAMPLES) selected.add(choices[rank].path);
    }
    const samples: DestinationSample[] = [];
    for (const path of selected) {
      if (stopped()) break;
      if (!cache.has(path)) cache.set(path, sampleText(await read(path)));
      const sample = cache.get(path)!;
      if (sample) samples.push({ path, sample, ...(examples.has(path) ? { folderPath: examples.get(path) } : {}) });
    }
    return samples;
  };
}
