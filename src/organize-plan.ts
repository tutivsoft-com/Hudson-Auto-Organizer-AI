import type { AppendOperation, MoveOperation, CreatedNoteOperation } from "./types";
import { diagnostics } from "./diagnostics";
import type { SourcePreview } from "./source-preview";
import { DEFAULT_POLICY, OrganizationPolicy, isEntryTarget, isFilingFolder, isAppendNote } from "./organization-policy";
import { isTrashPath, trashDestination } from "./trash";

export interface PlanAction {
  id: string;
  kind: "file" | "duplicate" | "line" | "trash";
  sourcePath: string;
  destination: string;
  reason: string;
  selected: boolean;
  status: "pending" | "done" | "failed";
  lineNumber?: number;
  lineEndNumber?: number;
  entryMode?: "append" | "capsule" | "archive";
  text?: string;
  keeperPath?: string;
  duplicateVerified?: boolean;
  outcome?: string;
  confidence?: number;
}

export interface OrganizePlan {
  policy?: OrganizationPolicy;
  id: string;
  title: string;
  actions: PlanAction[];
  snapshots: Record<string, string>;
  folders: string[];
  categories: string[];
  archives: Record<string, string>;
  archived: Set<string>;
  deferred: Array<{ path: string; reason: string }>;
  moves: MoveOperation[];
  appends: AppendOperation[];
  previews?: Record<string, SourcePreview>;
  pendingMoves?: MoveOperation[];
  createdNotes?: CreatedNoteOperation[];
  sourceEdits?: import("./types").SourceEdit[];
}

export interface PlanHost {
  fingerprint(path: string): Promise<string>;
  exists(path: string): boolean;
  isFolder(path: string): boolean;
  isNote(path: string): boolean;
  move(from: string, to: string): Promise<void>;
  appendLine(source: string, target: string, text: string): Promise<AppendOperation | null>;
  createNote?(path: string, text: string): Promise<string | void>;
  removeSourceEntry(action: PlanAction): Promise<void>;
  save(): Promise<void>;
}

// Keep real line numbers. Structured Markdown stays intact and is never archived by line filing.
export function captureLines(content: string): { lines: Array<{ lineNumber: number; text: string }>; canArchive: boolean } {
  const lines: Array<{ lineNumber: number; text: string }> = [];
  let frontmatter = false;
  let fence = "";
  let canArchive = true;
  content.split(/\r?\n/u).forEach((text, index) => {
    const trimmed = text.trim();
    if (index === 0 && trimmed === "---") { frontmatter = true; canArchive = false; return; }
    if (frontmatter) { if (trimmed === "---" || trimmed === "...") frontmatter = false; return; }
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(text)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      canArchive = false;
      return;
    }
    if (fence || /^\s{0,3}(?:#{1,6}\s|(?:[-*_]\s*){3,}$|>|\|)/u.test(text) || /^(?: {4}|\t)/u.test(text)) {
      canArchive = false;
      return;
    }
    if (trimmed) lines.push({ lineNumber: index + 1, text });
  });
  return { lines, canArchive };
}

export function withoutFiledEntries(original: string, actions: PlanAction[]): string {
  const removed = new Set<number>();
  for (const action of actions) {
    const start = action.lineNumber || 1;
    const end = action.lineEndNumber || start;
    const lines = original.split(/\r?\n/u);
    if (start < 1 || end < start || end > lines.length || lines.slice(start - 1, end).join("\n") !== action.text?.replace(/\r\n/gu, "\n")) throw new Error("Entry no longer matches its original lines. Create a new preview.");
    for (let line = start; line <= end; line++) removed.add(line);
  }
  const physical = original.match(/[^\n]*\n|[^\n]+$/gu) || [];
  return physical.filter((_line, index) => !removed.has(index + 1)).join("");
}

export function actionTarget(action: PlanAction): string {
  if (action.kind === "line" || action.kind === "duplicate" || action.kind === "trash") return action.destination;
  const name = action.sourcePath.split("/").pop()!;
  return action.destination && action.destination !== "/" ? `${action.destination}/${name}` : name;
}

export function pendingActions(plan: OrganizePlan): PlanAction[] {
  return plan.actions.filter((action) => action.status === "pending" && action.selected && action.destination !== "");
}

// One executor serves preview, single-item and automatic runs. Stop only between complete actions.
export async function executePlan(
  plan: OrganizePlan,
  host: PlanHost,
  ids: Set<string>,
  stopped: () => boolean,
  changed: () => void = () => {}
): Promise<void> {
  const policy = plan.policy || DEFAULT_POLICY;
  await host.save();
  for (const action of plan.actions) {
    if (stopped()) break;
    if (!ids.has(action.id) || action.status !== "pending") continue;
    try {
      if (await host.fingerprint(action.sourcePath) !== plan.snapshots[action.sourcePath]) {
        throw new Error("Source changed since preview. Create a new preview.");
      }
      if (action.kind === "duplicate" && (!action.keeperPath || !action.duplicateVerified)) throw new Error("Rebuild the preview to verify the full duplicate contents.");
      if (action.keeperPath) {
        const keeper = plan.moves.find((move) => move.fromPath === action.keeperPath)?.toPath || action.keeperPath;
        if (await host.fingerprint(keeper) !== plan.snapshots[action.keeperPath]) {
          throw new Error("The retained copy changed. Create a new preview.");
        }
      }
      if (action.kind === "line") {
        if (!action.text?.trim()) throw new Error("This entry has no text to file.");
        if (action.sourcePath === action.destination) throw new Error("Choose a different category note.");
        if (action.entryMode === "capsule" || action.entryMode === "archive") {
          const folder = action.entryMode === "capsule" ? policy.capsuleFolder : policy.archiveFolder;
          if (!isEntryTarget(action.destination, folder) || !plan.folders.includes(folder) || !host.isFolder(folder) || !host.createNote) throw new Error("Choose a permitted entry destination.");
          if (host.exists(action.destination)) throw new Error("The entry path is occupied. Nothing was overwritten.");
          const note = { sourcePath: action.sourcePath, targetPath: action.destination, text: action.text.endsWith("\n") ? action.text : action.text + "\n" };
          (plan.createdNotes ||= []).push(note);
          await host.save();
          let reused: string | void;
          try { reused = await host.createNote(note.targetPath, note.text); }
          catch (error) { if (!host.exists(note.targetPath)) plan.createdNotes = plan.createdNotes.filter((item) => item !== note); throw error; }
          if (reused) {
            plan.createdNotes = plan.createdNotes.filter((item) => item !== note);
            action.destination = reused;
            action.outcome = "Identical entry already exists; retained one active copy";
          } else action.outcome = action.entryMode === "capsule" ? "Idea note created" : "Entry archived";
        } else {
          if (!isAppendNote(action.destination, policy) || !plan.categories.includes(action.destination) || !host.isNote(action.destination)) throw new Error("Choose an existing category file allowed by your saved rules.");
          const append = await host.appendLine(action.sourcePath, action.destination, action.text);
          if (append) plan.appends.push(append);
          action.outcome = append ? "Filed" : "Already filed; no text added";
        }
        await host.removeSourceEntry(action);
        plan.snapshots[action.sourcePath] = await host.fingerprint(action.sourcePath);
      } else {
        if (action.kind === "file" && (!isFilingFolder(action.destination, policy) || !plan.folders.includes(action.destination) || !host.isFolder(action.destination))) throw new Error("Choose a whole-note destination allowed by your saved rules.");
        if ((action.kind === "trash" || action.kind === "duplicate") && !isTrashPath(action.destination)) throw new Error("Deleted copies must go to Deleted.");
        let to = actionTarget(action);
        if (to === action.sourcePath) throw new Error("This file is already in that folder.");
        if (action.kind === "file" && host.exists(to) && await host.fingerprint(to) === await host.fingerprint(action.sourcePath)) {
          action.kind = "duplicate"; action.keeperPath = to; action.duplicateVerified = true;
          plan.snapshots[to] = await host.fingerprint(to);
          action.destination = trashDestination(plan.id, action.sourcePath);
          to = action.destination;
        }
        if (host.exists(to)) throw new Error(`A file already exists at ${to}. Nothing was overwritten.`);
        const move: MoveOperation = { fromPath: action.sourcePath, toPath: to, ...(action.kind === "trash" || action.kind === "duplicate" ? { kind: "trash" as const } : {}) };
        (plan.pendingMoves ||= []).push(move);
        await host.save();
        await host.move(action.sourcePath, to);
        plan.moves.push(move);
        plan.pendingMoves = plan.pendingMoves.filter((pending) => pending !== move);
        action.outcome = action.kind === "trash" || action.kind === "duplicate" ? "Moved to Deleted; recoverable with Undo" : "Moved";
      }
      action.status = "done";
      diagnostics.event("action.completed", { runId: plan.id, operation: action.kind === "trash" || action.kind === "duplicate" ? "trash" : action.kind === "line" ? action.entryMode === "capsule" ? "capsule" : action.entryMode === "archive" ? "archive" : "append" : "move" });
    } catch (error) {
      diagnostics.failure("action.apply", error, { runId: plan.id });
      action.status = "failed";
      action.outcome = error instanceof Error ? error.message : "Could not apply this action.";
      if (host.exists(action.sourcePath)) plan.pendingMoves = plan.pendingMoves?.filter((move) => move.fromPath !== action.sourcePath || host.exists(move.toPath));
    }
    // Persist every completed action before continuing or honoring Stop.
    await host.save();
    changed();
    const siblings = plan.actions.filter((item) => item.sourcePath === action.sourcePath);
    const archive = plan.archives[action.sourcePath];
    if (archive && !stopped() && !plan.archived.has(action.sourcePath) && siblings.length && siblings.every((item) => item.kind === "line" && item.status === "done")) {
      try {
        if (await host.fingerprint(action.sourcePath) !== plan.snapshots[action.sourcePath]) throw new Error("Source changed; kept in place.");
        if (host.exists(archive)) throw new Error("Processed path is occupied; source kept in place.");
        if (!isTrashPath(archive)) throw new Error("Processed originals must go to Deleted.");
        const move: MoveOperation = { fromPath: action.sourcePath, toPath: archive, kind: "trash" };
        (plan.pendingMoves ||= []).push(move);
        await host.save();
        await host.move(action.sourcePath, archive);
        plan.moves.push(move);
        plan.pendingMoves = plan.pendingMoves.filter((pending) => pending !== move);
        plan.archived.add(action.sourcePath);
      } catch (error) {
        if (host.exists(action.sourcePath)) plan.pendingMoves = plan.pendingMoves?.filter((move) => move.fromPath !== action.sourcePath || host.exists(move.toPath));
        diagnostics.failure("action.archive", error, { runId: plan.id });
        plan.deferred.push({ path: action.sourcePath, reason: error instanceof Error ? error.message : "Source kept in place." });
      }
      await host.save();
      changed();
    }
  }
}
