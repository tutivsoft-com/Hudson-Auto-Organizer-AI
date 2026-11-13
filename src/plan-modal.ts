import { App, Modal } from "obsidian";
import manifest from "../manifest.json";
import { diagnostics } from "./diagnostics";
import { actionTarget, OrganizePlan, pendingActions, PlanAction } from "./organize-plan";
import { DestinationSuggest } from "./destination-suggest";

export interface ReviewOptions {
  categoryFolder?: string;
  suggestLines?: (status: (text: string) => void, stopped: () => boolean) => Promise<void>;
  groupLines?: (ids: Set<string>) => Promise<void>;
  changeEntryMode?: (action: PlanAction, mode: "append" | "capsule" | "archive") => void;
  build?: (manual: boolean, status: (text: string) => void, stopped: () => boolean) => Promise<void>;
  automatic?: boolean;
  localPreview?: boolean;
  apply: (ids: Set<string>, stopped: () => boolean, changed: () => void) => Promise<void>;
  split: (path: string) => Promise<void>;
  whole: (path: string) => void;
  open: (path: string, line?: number) => void;
  finish: () => Promise<void>;
  release: () => void;
  undo: () => Promise<boolean>;
  trash?: (path: string) => Promise<void>;
}

export interface ReviewSurface {
  app: App;
  rootEl: HTMLElement;
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  close(): void;
}

export class PlanReview {
  private busy = false;
  private stopRequested = false;
  private closed = false;
  private built = false;
  private stage: "file" | "line" = "file";
  private message = "";
  private expanded = new Set<string>();
  private destinationSuggesters: DestinationSuggest[] = [];

  constructor(private readonly plan: OrganizePlan, private readonly options: ReviewOptions, private readonly surface: ReviewSurface) {}

  get contentEl(): HTMLElement { return this.surface.contentEl; }
  get titleEl(): HTMLElement { return this.surface.titleEl; }
  open(): void { this.onOpen(); }
  close(): void { this.onClose(); this.surface.close(); }

  onOpen(): void {
    this.surface.rootEl.addClass("oao-plan-surface");
    this.built = !this.options.build;
    this.plan.actions.filter((action) => action.status === "pending").forEach((action) => { action.selected = false; });
    if (this.built && !this.plan.actions.some((action) => action.kind !== "line")) this.stage = "line";
    this.render();
  }

  private button(parent: HTMLElement, text: string, click: () => void, disabled = false): HTMLButtonElement {
    const button = parent.createEl("button", { text });
    button.disabled = disabled;
    button.addEventListener("click", click);
    return button;
  }

  render(): void {
    if (this.closed) return;
    const el = this.contentEl;
    const scroll = el.querySelector(".oao-plan-list")?.scrollTop || 0;
    const focused = el.ownerDocument.activeElement as HTMLElement | null;
    const focusedRow = focused?.closest<HTMLElement>("[data-action-id]")?.dataset.actionId;
    const focusedTag = focused?.tagName.toLowerCase();
    this.destinationSuggesters.forEach((suggest) => suggest.close());
    this.destinationSuggesters = [];
    el.empty();
    const applied = this.plan.actions.some((action) => action.status === "done");
    this.titleEl.setText(this.built ? this.busy ? "Working" : applied ? "Review results" : "Review" : this.plan.title);
    this.titleEl.addClass("oao-review-title");
    if (!this.built) el.createEl("p", { text: this.options.localPreview ? "Exact duplicate checking is local. No AI credits." : "AI preview uses one run credit. Manual choices use no AI credits.", cls: "oao-start-hint" });
    const topbar = el.createDiv({ cls: "oao-review-topbar" });
    if (!this.built) {
      const start = topbar.createDiv({ cls: "oao-plan-toolbar" });
      this.button(start, this.options.automatic ? "Run automatically" : this.options.localPreview ? "Build duplicate preview" : "Build AI preview", () => void this.build(false), this.busy).addClass("mod-cta");
      this.button(start, "Choose destinations manually", () => void this.build(true), this.busy);
    }
    const status = topbar.createEl("span", { cls: "oao-plan-status", attr: { role: "status", "aria-live": "polite" } });
    const updateCount = (): void => {
      const failed = this.plan.actions.filter((a) => a.status === "failed").length;
      status.setText(this.message || `${this.plan.actions.filter((a) => a.status === "pending" && a.selected).length} selected, ${this.plan.actions.filter((a) => a.status === "done").length} applied${failed ? `, ${failed} failed` : ""}`);
      const apply = el.querySelector<HTMLButtonElement>(".oao-apply-selected");
      if (apply) { const count = pendingActions(this.plan).length; apply.setText(`Apply selected (${count})`); apply.disabled = !count; }
    };
    updateCount();
    if (this.built) {
      const stages = topbar.createDiv({ cls: "oao-plan-toolbar", attr: { "aria-label": "Review stage" } });
      for (const [stage, label] of [["file", "1. Files"], ["line", "2. Lines"]] as const) {
        const count = this.plan.actions.filter((a) => stage === "line" ? a.kind === "line" : a.kind !== "line").length;
        const button = this.button(stages, `${label} (${count})`, () => { this.stage = stage; this.render(); }, this.busy);
        button.setAttribute("aria-pressed", String(stage === this.stage));
        button.dataset.tone = stage === "file" ? "1" : "2";
      }
      const selection = topbar.createDiv({ cls: "oao-plan-toolbar" });
      const visible = this.plan.actions.filter((a) => this.stage === "line" ? a.kind === "line" : a.kind !== "line");
      this.button(selection, "Select all", () => { this.plan.actions.filter((a) => a.status === "pending" && a.destination).forEach((a) => { a.selected = true; }); this.message = ""; this.render(); }, this.busy);
      this.button(selection, "Select none", () => { this.plan.actions.forEach((a) => { a.selected = false; }); this.message = ""; this.render(); }, this.busy);
      if (this.stage === "line" && this.options.groupLines) {
        const chosen = this.plan.actions.filter((a) => a.kind === "line" && a.status === "pending" && a.selected);
        this.button(selection, "Group selected lines", () => void this.groupLines(), this.busy || chosen.length < 2 || new Set(chosen.map((a) => a.sourcePath)).size !== 1);
      }
      if (this.stage === "line" && this.options.suggestLines) {
        const suggest = this.button(selection, "Suggest line destinations", () => void this.suggestLines(), this.busy || !this.plan.categories.length || !this.plan.actions.some((a) => a.kind === "line" && a.status === "pending" && !a.destination));
        suggest.setAttribute("title", "AI suggests files for unresolved lines using one run credit. Existing choices stay unchanged; nothing is applied.");
      } else if (this.options.build) this.button(selection, this.options.localPreview ? "Refresh duplicate preview" : "Suggest remaining", () => void this.build(false, true), this.busy || !this.plan.actions.some((a) => a.kind !== "line" && a.status === "pending" && !a.destination));
      const list = el.createDiv({ cls: "oao-plan-list" });
      if (this.stage === "line" && this.plan.categories.length) {
        list.createEl("p", { text: `Append lines to files${this.options.categoryFolder ? ` in ${this.options.categoryFolder}` : ""} (${this.plan.categories.length} files).`, cls: "oao-line-destinations-hint" });
      }
      if (this.stage === "line" && !this.plan.categories.length) {
        list.createEl("p", { text: "No category files were found in your configured append folders. Add suitable Markdown files there, then start a fresh preview." });
      }
      const paths = [...new Set(visible.map((a) => a.sourcePath))];
      for (const [pathIndex, path] of paths.entries()) {
        const actions = visible.filter((a) => a.sourcePath === path);
        const completed = actions.every((a) => a.status === "done");
        const deleted = completed && actions.every((a) => a.kind === "trash" || a.kind === "duplicate");
        const group = list.createEl("details", { cls: "oao-plan-group" });
        group.dataset.tone = String(pathIndex % 5 + 1);
        group.dataset.state = actions.some((a) => a.status === "failed") ? "failed" : deleted ? "trash" : completed ? "done" : actions.some((a) => !a.destination || a.confidence !== undefined && a.confidence < 0.88) ? "review" : "ready";
        group.open = !completed && (this.stage === "file" || this.expanded.has(path));
        group.addEventListener("toggle", () => { if (group.open) this.expanded.add(path); else this.expanded.delete(path); });
        const summary = group.createEl("summary");
        summary.createEl("span", { text: `${pathIndex + 1}. ${this.stage === "line" ? `${path}: ${actions.length} entries` : path}`, cls: "oao-source-name" });
        if (completed) summary.createEl("span", { text: deleted ? "Deleted" : this.stage === "line" ? "Filed" : "Moved", cls: deleted ? "oao-deleted-label" : "oao-moved-label" });
        const controls = summary.createDiv({ cls: "oao-plan-toolbar oao-source-controls" });
        controls.addEventListener("click", (event) => event.stopPropagation());
        this.button(controls, completed ? deleted ? "Open deleted file" : "Open destination" : "Open source", () => this.options.open(completed ? actionTarget(actions[0]) : path), this.busy);
        const anyDone = this.plan.actions.some((a) => a.sourcePath === path && a.status === "done");
        if (this.options.trash && !completed) {
          const remove = this.button(controls, "Delete file", () => void this.trash(path), this.busy || anyDone);
          remove.addClass("oao-delete-button");
          remove.setAttribute("title", "Move this file to Deleted at the vault root. Undo restores its original path.");
          remove.setAttribute("aria-label", `Delete file ${path}`);
          remove.setAttribute("title", `Move ${path} to Deleted. Undo restores its original path.`);
        }
        if (!completed && this.stage === "file" && path.toLowerCase().endsWith(".md")) {
          this.button(controls, "Choose line by line", () => void this.split(path), this.busy || anyDone);
        } else if (!completed && this.stage === "line") {
          this.button(controls, "Move as a whole file instead", () => { this.options.whole(path); this.stage = "file"; this.render(); }, this.busy || anyDone);
          group.createEl("p", { text: this.plan.archives[path]
            ? "Each filed entry is removed from this source. When all entries are filed, the remaining source moves to Deleted. Undo restores the original text."
            : "Filed entries are removed. Headings, code and other structure stay in this source. Undo restores filed text.", cls: "setting-item-description" });
        }
        const layout = group.createDiv({ cls: this.stage === "file" ? "oao-file-layout" : "" });
        if (this.stage === "file" && !completed) {
          const preview = this.plan.previews?.[path];
          const source = layout.createDiv({ cls: "oao-source-preview" });
          if (preview) {
            source.createEl("small", { text: `${preview.totalLines} lines`, cls: "oao-preview-count" });
            for (const section of preview.sections) {
              const block = source.createDiv();
              block.createEl("strong", { text: section.label });
              block.createEl("pre", { text: section.lines.map((line) => `${line.number}  ${line.text}`).join("\n") || "Empty note" });
            }
          } else source.createEl("p", { text: "Open source to preview this file type." });
        }
        const destinations = layout.createDiv({ cls: "oao-destinations" });
        for (const [actionIndex, action] of actions.entries()) this.renderAction(destinations, action, updateCount, this.stage === "line" ? `${pathIndex + 1}.${actionIndex + 1}` : String(pathIndex + 1), this.stage === "line" ? actionIndex : pathIndex);
      }
      if (!paths.length) list.createEl("p", { text: this.stage === "line" ? "No line choices yet. Use Choose line by line on a file." : "No files in this stage." });
      if (this.plan.deferred.length) {
        const details = el.createEl("details");
        details.createEl("summary", { text: `Kept for review (${this.plan.deferred.length})` });
        for (const item of this.plan.deferred) details.createEl("p", { text: `${item.path}: ${item.reason}` });
      }
    }
    const footer = el.createDiv({ cls: "oao-plan-footer" });
    const help = footer.createEl("details", { cls: "oao-review-help" });
    help.createEl("summary", { text: "Help" });
    help.createEl("p", { text: "Nothing is selected by default. Move applies one file; Apply selected uses checked choices from both stages. Group selected lines keeps one idea together. Your saved rules choose category files, original-idea folders and review destinations. Delete, exact duplicate extras and fully processed originals go to Deleted. Undo restores originals and removes exact appends; created entry files move to Deleted on Undo. Five colors distinguish neighboring records. Filed and moved cards collapse with a grey-blue background. Deleted cards collapse with a grey-red background and crossed-out name. Labels show status; failed actions stay expanded." });
    footer.createEl("small", { text: `v${manifest.version}`, cls: "oao-version" });
    if (this.busy) this.button(footer, this.stopRequested ? "Stopping after current action..." : "Stop", () => { diagnostics.event("review.stop_requested", { runId: this.plan.id }); this.stopRequested = true; this.render(); }, this.stopRequested);
    else {
      this.button(footer, this.plan.moves.length || this.plan.appends.length || this.plan.createdNotes?.length || this.plan.sourceEdits?.length ? "Done" : "Cancel", () => this.close());
      if (this.plan.moves.length || this.plan.appends.length || this.plan.createdNotes?.length || this.plan.sourceEdits?.length) this.button(footer, "Undo this run", () => void this.undo());
      if (this.built) {
        const lineCount = this.plan.actions.filter((a) => a.kind === "line" && a.status === "pending").length;
        if (this.stage === "file" && lineCount) this.button(footer, `Review lines (${lineCount})`, () => { this.stage = "line"; this.render(); }).addClass("mod-cta");
        const apply = this.button(footer, `Apply selected (${pendingActions(this.plan).length})`, () => void this.apply(new Set(pendingActions(this.plan).map((a) => a.id))), !pendingActions(this.plan).length);
        apply.addClass("mod-cta");
        apply.addClass("oao-apply-selected");
      }
    }
    const list = el.querySelector(".oao-plan-list");
    if (list) list.scrollTop = scroll;
    if (focusedRow && (focusedTag === "select" || focusedTag === "input")) {
      const selector = focused?.classList.contains("oao-destination-input") ? ".oao-destination-input" : focusedTag;
      el.querySelector<HTMLElement>(`[data-action-id="${focusedRow}"] ${selector}`)?.focus({ preventScroll: true });
    }
  }

  private renderAction(parent: HTMLElement, action: PlanAction, updateCount: () => void, number: string, colorIndex: number): void {
    const completed = action.status === "done";
    const deleted = action.kind === "trash" || action.kind === "duplicate";
    const row = parent.createEl(completed ? "details" : "div", { cls: "oao-plan-row" });
    row.dataset.tone = String(colorIndex % 5 + 1);
    if (completed) row.createEl("summary", { text: `${number}. ${deleted ? "Deleted" : action.kind === "line" ? "Filed" : "Moved"}: ${actionTarget(action)}`, cls: "oao-completed-summary" });
    row.dataset.actionId = action.id;
    row.dataset.state = action.status === "failed" ? "failed" : completed && deleted ? "trash" : completed ? "done" : !action.destination || (action.confidence !== undefined && action.confidence < 0.88) ? "review" : "ready";
    if (action.selected) row.addClass("oao-selected");
    const command = row.createDiv({ cls: "oao-action-command" });
    const label = command.createEl("label");
    const checkbox = label.createEl("input", { type: "checkbox" });
    checkbox.checked = action.selected;
    checkbox.disabled = this.busy || action.status !== "pending";
    checkbox.addEventListener("change", () => { action.selected = checkbox.checked; this.message = ""; this.render(); });
    label.createEl("span", { text: `${number}. ` + (action.kind === "line" ? action.lineEndNumber && action.lineEndNumber > action.lineNumber! ? `Lines ${action.lineNumber}-${action.lineEndNumber}` : `Line ${action.lineNumber}` : "Select file") });
    if (action.kind === "line" && this.options.changeEntryMode) {
      const mode = command.createEl("select", { cls: "oao-entry-mode", attr: { "aria-label": `Filing type for ${action.sourcePath} line ${action.lineNumber}` } });
      for (const [value, text] of [["append", "Existing category note"], ["capsule", "Original idea"], ["archive", "Unclear entry"]]) mode.createEl("option", { value, text });
      mode.value = action.entryMode || "append";
      mode.disabled = this.busy || action.status !== "pending";
      mode.addEventListener("change", () => {
        this.options.changeEntryMode?.(action, mode.value as "append" | "capsule" | "archive");
        delete action.confidence;
        action.reason = "Manual filing choice. Original ideas use your configured idea folder.";
        this.render();
      });
    }
    const emptyDestination = action.kind === "line" ? "Choose file" : "Choose folder";
    const badge = command.createEl("span", { cls: "oao-state-badge", text: action.status === "failed" ? "Failed" : action.kind === "trash" ? "In Deleted" : action.status === "done" ? "Completed" : !action.destination ? emptyDestination : action.confidence !== undefined ? `${action.confidence < 0.88 ? "Review" : "Suggested"} ${Math.round(action.confidence * 100)}%` : "Ready" });
    if (action.confidence !== undefined) badge.setAttribute("title", `AI confidence: ${Math.round(action.confidence * 100)}%`);
    const choices = command.createEl("input", { type: "text", cls: "oao-destination-input", attr: { autocomplete: "off", spellcheck: "false", placeholder: action.kind === "line" ? `Search files${this.options.categoryFolder ? ` in ${this.options.categoryFolder}` : ""}...` : "Search folders...", "aria-label": `Destination ${action.kind === "line" ? "file" : "folder"} for ${action.sourcePath}${action.lineNumber ? ` line ${action.lineNumber}` : ""}`, title: action.destination ? actionTarget(action) : action.kind === "line" ? "Choose an existing Markdown file to append this line to" : "Type to search existing folders" } });
    const values = action.kind === "line" ? [...this.plan.categories].sort((a, b) => a.localeCompare(b)) : this.plan.folders;
    const originalDestination = action.destination;
    const allowed = [...new Set([...(action.kind === "duplicate" || action.kind === "trash" ? [originalDestination] : []), ...values])].filter(Boolean);
    choices.value = action.destination;
    choices.disabled = this.busy || action.status !== "pending" || action.kind === "trash" || action.kind === "duplicate" || action.kind === "line" && Boolean(action.entryMode && action.entryMode !== "append");
    choices.addEventListener("focus", () => choices.select());
    choices.addEventListener("input", () => {
      const query = choices.value.trim();
      const destination = allowed.find((path) => path === query) || allowed.find((path) => path.toLowerCase() === query.toLowerCase()) || "";
      if (destination && action.kind === "duplicate" && destination !== originalDestination) { action.kind = "file"; delete action.keeperPath; }
      action.destination = destination;
      delete action.confidence;
      action.selected = action.selected && Boolean(destination);
      checkbox.checked = action.selected;
      row.classList.toggle("oao-selected", action.selected);
      row.dataset.state = !destination || (action.confidence !== undefined && action.confidence < 0.88) ? "review" : "ready";
      badge.setText(!destination ? emptyDestination : action.confidence !== undefined ? `${action.confidence < 0.88 ? "Review" : "Suggested"} ${Math.round(action.confidence * 100)}%` : "Ready");
      choices.setAttribute("aria-invalid", String(Boolean(query) && !destination));
      choices.setAttribute("title", destination ? actionTarget(action) : action.kind === "line" ? "Choose a matching existing file before appending this line" : "Choose a matching existing folder before moving");
      const move = buttons.querySelector<HTMLButtonElement>(".mod-cta");
      if (move) move.disabled = !destination;
      this.message = "";
      updateCount();
    });
    // Keep the clicked button alive when changing focus from this field.
    choices.addEventListener("change", () => { if (action.destination) choices.value = action.destination; });
    if (!choices.disabled) {
      const suggest = new DestinationSuggest(this.surface.app, choices, allowed, action.kind === "line", () => {
        const event = choices.ownerDocument.createEvent("Event");
        event.initEvent("input", true, false);
        choices.dispatchEvent(event);
      });
      this.destinationSuggesters.push(suggest);
    }
    const buttons = command.createDiv({ cls: "oao-plan-toolbar" });
    if (action.kind === "line") this.button(buttons, completed ? "Open destination" : "Open at line", () => this.options.open(completed ? action.destination : action.sourcePath, completed ? undefined : (action.lineNumber || 1) - this.plan.actions.filter((item) => item.sourcePath === action.sourcePath && item.kind === "line" && item.status === "done" && (item.lineEndNumber || item.lineNumber || 1) < (action.lineNumber || 1)).reduce((count, item) => count + (item.lineEndNumber || item.lineNumber || 1) - (item.lineNumber || 1) + 1, 0)), this.busy);
    if (action.status === "pending") {
      const move = this.button(buttons, action.kind === "line" ? action.entryMode === "capsule" ? "Save idea" : action.entryMode === "archive" ? "Archive entry" : "Apply this line" : action.kind === "duplicate" ? "Delete duplicate" : "Move", () => void this.apply(new Set([action.id])), this.busy || !action.destination);
      move.addClass("mod-cta");
      move.setAttribute("aria-label", action.kind === "line" ? `Apply line ${action.lineNumber} from ${action.sourcePath}` : `Move file ${action.sourcePath}`);
    }
    if (action.kind === "line") row.createEl("pre", { text: action.text || "", cls: "oao-line-preview" });
    row.createEl("p", { text: action.reason, cls: "oao-action-reason", attr: { title: action.reason } });
    if (action.outcome) row.createEl("p", { text: action.outcome, attr: { role: "status" } });
  }

  private async build(manual: boolean, remaining = false): Promise<void> {
    if (this.busy || this.built && !remaining) return;
    this.busy = true;
    const started = performance.now();
    diagnostics.event("preview.started", { runId: this.plan.id, operation: manual ? "manual" : "preview" });
    this.stopRequested = false;
    this.message = manual ? "Reading files..." : "Building preview...";
    this.render();
    try {
      await this.options.build?.(manual, (text) => { this.message = text; this.render(); }, () => this.stopRequested || this.closed);
      this.built = true;
      this.plan.actions.filter((action) => action.status === "pending").forEach((action) => { action.selected = false; });
      diagnostics.event("preview.completed", { runId: this.plan.id, count: this.plan.actions.length, elapsedMs: Math.round(performance.now() - started) });
      if (!this.plan.actions.some((a) => a.kind !== "line")) this.stage = "line";
      this.message = this.stopRequested ? "Planning stopped. Nothing has been applied." : "";
    } catch (error) {
      diagnostics.failure("preview.build", error, { runId: this.plan.id });
      this.message = error instanceof Error ? error.message : "Could not build a plan.";
    } finally { this.busy = false; this.render(); }
    if (this.built && this.options.automatic && !manual && !remaining && !this.stopRequested && !this.closed) {
      this.plan.actions.filter((action) => action.status === "pending" && action.destination && (action.confidence ?? 0) >= 0.88).forEach((action) => { action.selected = true; });
      await this.apply(new Set(pendingActions(this.plan).map((a) => a.id)));
    }
    if (this.closed) this.options.release();
  }

  private async groupLines(): Promise<void> {
    if (this.busy || this.closed || !this.options.groupLines) return;
    const ids = new Set(this.plan.actions.filter((a) => a.kind === "line" && a.status === "pending" && a.selected).map((a) => a.id));
    this.busy = true; this.render();
    try { await this.options.groupLines(ids); this.message = "Related lines grouped. Choose a category note, original idea or review destination."; }
    catch (error) { this.message = error instanceof Error ? error.message : "Could not group these lines."; }
    finally { this.busy = false; this.render(); if (this.closed) this.options.release(); }
  }

  private async suggestLines(): Promise<void> {
    if (this.busy || this.closed || !this.options.suggestLines) return;
    this.busy = true;
    this.stopRequested = false;
    this.message = "Suggesting line destinations...";
    this.render();
    diagnostics.event("preview.started", { runId: this.plan.id, operation: "classify" });
    try {
      await this.options.suggestLines((text) => { this.message = text; this.render(); }, () => this.stopRequested || this.closed);
      this.message = this.stopRequested ? "Suggestions stopped. Nothing was applied." : "Review the suggested files. Nothing was applied.";
      diagnostics.event("preview.completed", { runId: this.plan.id, lines: this.plan.actions.filter((a) => a.kind === "line" && Boolean(a.destination)).length });
    } catch (error) {
      diagnostics.failure("preview.lines", error, { runId: this.plan.id });
      this.message = error instanceof Error ? error.message : "Could not suggest line destinations.";
    } finally { this.busy = false; this.render(); if (this.closed) this.options.release(); }
  }

  private async apply(ids: Set<string>): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    diagnostics.event("apply.started", { runId: this.plan.id, count: ids.size });
    this.stopRequested = false;
    this.message = "Applying changes...";
    this.render();
    try {
      await this.options.apply(ids, () => this.stopRequested || this.closed, () => this.render());
      this.message = this.stopRequested || this.closed ? "Stopped. Completed changes are saved and can be undone." : "";
    } catch (error) { diagnostics.failure("apply.save", error, { runId: this.plan.id }); this.message = "Stopped because progress could not be saved. Check recent moves before continuing."; }
    finally {
      try { await this.options.finish(); }
      catch (error) { diagnostics.failure("report.save", error, { runId: this.plan.id }); this.message = "Changes applied, but the run report could not be saved. Check recent moves."; }
      diagnostics.event("apply.completed", { runId: this.plan.id, applied: this.plan.actions.filter((a) => a.status === "done").length, failed: this.plan.actions.filter((a) => a.status === "failed").length, status: this.stopRequested || this.closed ? "stopped" : "completed" });
      this.busy = false;
      this.render();
      if (this.closed) this.options.release();
    }
  }

  private async split(path: string): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    diagnostics.event("lines.started", { runId: this.plan.id });
    this.render();
    try { await this.options.split(path); this.stage = "line"; this.expanded.add(path); diagnostics.event("lines.completed", { runId: this.plan.id, count: this.plan.actions.filter((a) => a.kind === "line").length }); }
    catch (error) { diagnostics.failure("lines.read", error, { runId: this.plan.id }); this.message = error instanceof Error ? error.message : "Could not read lines."; }
    finally { this.busy = false; this.render(); if (this.closed) this.options.release(); }
  }

  private async undo(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    diagnostics.event("undo.started", { runId: this.plan.id });
    this.render();
    try {
      if (await this.options.undo()) { diagnostics.event("undo.completed", { runId: this.plan.id }); this.close(); }
      else { diagnostics.event("undo.stopped", { runId: this.plan.id }); this.message = "Undo stopped to protect changed files. Check the notice and recent moves."; }
    }
    catch (error) { diagnostics.failure("undo.apply", error, { runId: this.plan.id }); this.message = "Undo could not finish. Check recent moves."; }
    finally { this.busy = false; this.render(); if (this.closed) this.options.release(); }
  }

  private async trash(path: string): Promise<void> {
    if (this.busy || this.closed || !this.options.trash) return;
    this.busy = true;
    this.render();
    try { await this.options.trash(path); this.message = "File moved to Deleted. Use Undo this run to restore it."; }
    catch (error) { diagnostics.failure("trash.move", error, { runId: this.plan.id }); this.message = error instanceof Error ? error.message : "Could not move the file to Deleted."; }
    finally { this.busy = false; this.render(); if (this.closed) this.options.release(); }
  }

  onClose(): void {
    if (this.closed) return;
    diagnostics.event("review.closed", { runId: this.plan.id, applied: this.plan.actions.filter((a) => a.status === "done").length });
    this.closed = true;
    this.stopRequested = true;
    this.destinationSuggesters.forEach((suggest) => suggest.close());
    this.destinationSuggesters = [];
    this.contentEl.empty();
    if (!this.busy) this.options.release();
  }
}

// The modal adapter is kept for isolated preview fixtures. The plugin uses a native workspace view.
export class PlanReviewModal extends Modal {
  private readonly review: PlanReview;
  constructor(app: App, plan: OrganizePlan, options: ReviewOptions) {
    super(app);
    this.modalEl.addClass("oao-plan-modal");
    this.review = new PlanReview(plan, options, { app, rootEl: this.modalEl, contentEl: this.contentEl, titleEl: this.titleEl, close: () => super.close() });
  }
  onOpen(): void { this.review.open(); }
  onClose(): void { this.review.onClose(); }
  render(): void { this.review.render(); }
}
