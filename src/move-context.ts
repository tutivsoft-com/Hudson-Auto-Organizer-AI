import { normalizePath, parentFolderPath } from "./folder-utils";
import { LearnedMove, MoveHistoryEntry } from "./types";

export interface PopularDestinationFolder {
  path: string;
  moveCount: number;
}

interface DestinationUsage {
  path: string;
  moveCount: number;
  lastUsedAt: number;
}

export function rankPopularDestinations(
  history: MoveHistoryEntry[],
  learnedMoves: LearnedMove[],
  allowedFolderPaths: string[],
  limit = 30
): PopularDestinationFolder[] {
  const allowedPaths = new Map(allowedFolderPaths.map((path) => [normalizePath(path), path]));
  const usage = new Map<string, DestinationUsage>();

  const addUsage = (path: string, count: number, usedAt: number): void => {
    const key = normalizePath(path);
    const allowedPath = allowedPaths.get(key);
    if (!allowedPath || count <= 0) return;

    const existing = usage.get(key);
    if (existing) {
      existing.moveCount += count;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, usedAt);
    } else {
      usage.set(key, { path: allowedPath, moveCount: count, lastUsedAt: usedAt });
    }
  };

  for (const entry of [...history].sort((a, b) => b.timestamp - a.timestamp).slice(0, 30)) {
    const destinations = new Set(
      (Array.isArray(entry.moves) ? entry.moves : [])
        .map((move) => parentFolderPath(move.toPath))
        .filter(Boolean)
        .map(normalizePath)
    );
    for (const path of destinations) addUsage(path, 1, entry.timestamp);
  }

  for (const learned of learnedMoves) {
    addUsage(learned.destinationFolder, Math.max(0, learned.count), learned.updatedAt);
  }

  return [...usage.values()]
    .sort((a, b) => b.moveCount - a.moveCount || b.lastUsedAt - a.lastUsedAt || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit))
    .map(({ path, moveCount }) => ({ path, moveCount }));
}
