import { TFolder } from "obsidian";

export function listFolders(root: TFolder): TFolder[] {
  const result: TFolder[] = [];
  const visit = (folder: TFolder): void => {
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        result.push(child);
        visit(child);
      }
    }
  };
  visit(root);
  return result;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim().toLocaleLowerCase();
}

export function isExcludedPath(path: string, userExclusions: string): boolean {
  const normalized = normalizePath(path);
  const exclusions = userExclusions
    .split(/[\r\n,;]/)
    .map(normalizePath)
    .filter(Boolean);
  return exclusions.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`));
}

function tokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}/]+/gu, " ")
    .split(/[\s/]+/)
    .filter((part) => part && !["folder", "folders", "the", "my", "this", "file", "note"].includes(part));
}

function tokenMatches(queryToken: string, folderToken: string): boolean {
  if (queryToken === folderToken) return true;
  return queryToken.length >= 2 && folderToken.startsWith(queryToken);
}

export function matchFolderPhrase(
  phrase: string,
  folders: TFolder[],
  allowExcluded: boolean,
  exclusions: string
): TFolder[] {
  const query = normalizePath(phrase);
  if (!query) return [];

  const eligible = folders.filter((folder) => allowExcluded || !isExcludedPath(folder.path, exclusions));
  const exactPath = eligible.filter((folder) => normalizePath(folder.path) === query);
  if (exactPath.length) return exactPath;

  const exactName = eligible.filter((folder) => normalizePath(folder.name) === query);
  if (exactName.length) return exactName;

  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];

  return eligible.filter((folder) => {
    const pathTokens = tokens(folder.path);
    return queryTokens.every((queryToken) => pathTokens.some((pathToken) => tokenMatches(queryToken, pathToken)));
  });
}

export function findFolderByPath(path: string, folders: TFolder[]): TFolder | undefined {
  const normalized = normalizePath(path);
  return folders.find((folder) => normalizePath(folder.path) === normalized);
}

export function parentFolderPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}
