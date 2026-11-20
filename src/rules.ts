import { FolderRule, LearnedMove } from "./types";
import { normalizePath, findFolderByPath, isExcludedPath } from "./folder-utils";
import { TFolder } from "obsidian";

export function parseRules(markdown: string): FolderRule[] {
  const rules: FolderRule[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || /^\|?\s*:?-{3,}/.test(line)) continue;

    if (line.startsWith("|")) {
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      if (cells.length >= 2 && !/^(phrase|alias|match)$/i.test(cells[0])) {
        rules.push({ phrase: cells[0], destination: cells[1].replace(/^`|`$/g, "") });
      }
      continue;
    }

    const match = line.match(/^(?:[-*]\s*)?(.+?)\s*(?:=>|->|=)\s*(.+?)\s*$/);
    if (match) rules.push({ phrase: match[1].trim().replace(/^`|`$/g, ""), destination: match[2].trim().replace(/^`|`$/g, "") });
  }
  return rules;
}

export function resolveRule(
  phrase: string,
  rules: FolderRule[],
  folders: TFolder[],
  userExclusions: string
): TFolder[] {
  const matching = rules.filter((rule) => normalizePath(rule.phrase) === normalizePath(phrase));
  const destinations = matching
    .map((rule) => findFolderByPath(rule.destination, folders))
    .filter((folder): folder is TFolder => Boolean(folder));
  return [...new Map(destinations.map((folder) => [normalizePath(folder.path), folder])).values()];
}

export function resolveLearnedMove(
  sourceFolder: string,
  fileName: string,
  learnedMoves: LearnedMove[],
  folders: TFolder[],
  userExclusions: string
): TFolder | undefined {
  const match = learnedMoves.find((item) =>
    normalizePath(item.sourceFolder) === normalizePath(sourceFolder) &&
    normalizePath(item.exampleName) === normalizePath(fileName) &&
    !isExcludedPath(item.destinationFolder, userExclusions)
  );
  if (!match) return undefined;
  return findFolderByPath(match.destinationFolder, folders);
}

export function createRulesTemplate(): string {
  return ["# Auto Organizer aliases", "", "Organization preferences are entered in Hudson settings. Optional shortcuts use one alias per line:", "", "Reference => Resources", "Ideas => Resources/Ideas", "", "Aliases must point to a whole-note folder allowed by your saved organization rules.", ""].join("\n");
}

const attachmentExclusion = /\b(?:without|excluding|except(?: for)?|exclude|skip|leave|no|(?:do not|don['’]t|never)\s+(?:move|include|bring|copy|take))\s+(?:(?:any|all|its|the|linked|my)\s+)*attachments?\b(?:\s+behind)?/i;
const attachmentInclusion = /\b(?:and|with|including|include|bring|move|take)\s+(?:(?:all|its|the|linked|my)\s+)*attachments?\b/i;

export function commandIncludesAttachments(instruction: string): boolean {
  return !attachmentExclusion.test(instruction) && attachmentInclusion.test(instruction);
}

export function extractDestinationPhrase(instruction: string): string | undefined {
  const cleaned = instruction
    .replace(attachmentExclusion, " ")
    .replace(attachmentInclusion, " ")
    .replace(/[,;]\s*$/, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  const match = cleaned.match(/\b(?:to|into)\s+(.+)$/i) ?? cleaned.match(/\bin\s+(.+)$/i);
  if (!match) return undefined;
  return match[1].trim().replace(/^the\s+folder\s+/i, "").replace(/^folder\s+/i, "").replace(/^["'`]|["'`]$/g, "");
}
