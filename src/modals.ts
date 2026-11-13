import { App, Modal, SuggestModal, TFolder } from "obsidian";
import { DuplicatePair } from "./duplicate-detection";

export interface DuplicateNote {
  path: string;
}

export interface AutoOrganizeDeferredItem {
  path: string;
  reason: string;
}

export interface AutoOrganizeRunSummary {
  sourceFolder: string;
  duplicateCount: number;
  fileMoveCount: number;
  lineRouteCount: number;
  deferred: AutoOrganizeDeferredItem[];
  reportPath: string;
  changes?: Array<{ kind: string; fromPath: string; toPath: string }>;
  onOpenPath: (path: string) => void;
}

export class AutoOrganizeResultsModal extends Modal {
  private readonly summary: AutoOrganizeRunSummary;

  constructor(app: App, summary: AutoOrganizeRunSummary) {
    super(app);
    this.summary = summary;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oao-auto-results");
    contentEl.createEl("h2", { text: "Auto Organize complete" });
    contentEl.createEl("p", { text: `Folder: ${this.summary.sourceFolder || "Vault root"}` });
    const list = contentEl.createEl("ul");
    list.createEl("li", { text: `${this.summary.duplicateCount} extra duplicate file${this.summary.duplicateCount === 1 ? "" : "s"} moved to Deleted.` });
    list.createEl("li", { text: `${this.summary.lineRouteCount} one-line entr${this.summary.lineRouteCount === 1 ? "y" : "ies"} filed in category notes.` });
    list.createEl("li", { text: `${this.summary.fileMoveCount} full note${this.summary.fileMoveCount === 1 ? "" : "s"} moved to destination folders.` });
    list.createEl("li", { text: `${this.summary.deferred.length} item${this.summary.deferred.length === 1 ? "" : "s"} deferred for your review.` });

    if (this.summary.changes?.length) {
      contentEl.createEl("h3", { text: "Changes" });
      const changes = contentEl.createEl("ul");
      for (const change of this.summary.changes) {
        changes.createEl("li", { text: `${change.kind}: ${change.fromPath} → ${change.toPath}` });
      }
    }

    if (this.summary.deferred.length) {
      contentEl.createEl("h3", { text: "Needs review" });
      const deferred = contentEl.createDiv({ cls: "oao-auto-deferred" });
      for (const item of this.summary.deferred) {
        const row = deferred.createDiv({ cls: "oao-duplicate-item" });
        row.createEl("strong", { text: item.path });
        row.createEl("div", { text: item.reason });
        const open = row.createEl("button", { text: "Open for review" });
        open.addEventListener("click", () => this.summary.onOpenPath(item.path));
      }
    }

    const report = contentEl.createEl("p");
    report.createEl("span", { text: "Run log: " });
    const openReport = report.createEl("button", { text: this.summary.reportPath });
    openReport.addEventListener("click", () => this.summary.onOpenPath(this.summary.reportPath));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class InstructionModal extends Modal {
  private readonly onSubmit: (instruction: string) => void;
  private readonly initialValue: string;

  constructor(app: App, initialValue: string, onSubmit: (instruction: string) => void) {
    super(app);
    this.initialValue = initialValue;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Organize with AI" });
    contentEl.createEl("p", { text: "An approved folder name or alias opens a move preview. A vague instruction uses AI to suggest a permitted destination." });
    const input = contentEl.createEl("textarea", { cls: "oao-instruction" });
    input.value = this.initialValue;
    input.placeholder = 'For example: "Move this to Resources" or "Put this where it belongs"';
    input.rows = 3;

    const actions = contentEl.createDiv({ cls: "oao-modal-actions" });
    const submit = actions.createEl("button", { text: "Organize", cls: "mod-cta" });
    submit.addEventListener("click", () => this.submit(input.value));
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        this.submit(input.value);
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  private submit(value: string): void {
    const instruction = value.trim();
    if (!instruction) return;
    this.close();
    this.onSubmit(instruction);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class FolderPickerModal extends SuggestModal<TFolder> {
  private readonly folders: TFolder[];
  private readonly onChoose: (folder: TFolder) => void;
  private readonly title: string;

  constructor(app: App, folders: TFolder[], title: string, onChoose: (folder: TFolder) => void) {
    super(app);
    this.folders = folders;
    this.title = title;
    this.onChoose = onChoose;
    this.setPlaceholder(title);
  }

  getSuggestions(query: string): TFolder[] {
    const value = query.trim().toLocaleLowerCase();
    return this.folders
      .filter((folder) => !value || folder.path.toLocaleLowerCase().includes(value))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  renderSuggestion(folder: TFolder, element: HTMLElement): void {
    element.createEl("div", { text: folder.name });
    element.createEl("small", { text: folder.path, cls: "oao-folder-path" });
  }

  onChooseSuggestion(folder: TFolder): void {
    this.onChoose(folder);
  }
}

export class DuplicateResultsModal extends Modal {
  private readonly folderPath: string;
  private readonly scannedCount: number;
  private readonly notes: DuplicateNote[];
  private readonly pairs: DuplicatePair[];

  constructor(app: App, folderPath: string, scannedCount: number, notes: DuplicateNote[], pairs: DuplicatePair[]) {
    super(app);
    this.folderPath = folderPath;
    this.scannedCount = scannedCount;
    this.notes = notes;
    this.pairs = pairs;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oao-duplicate-results");
    contentEl.createEl("h2", { text: "Duplicate note candidates" });
    contentEl.createEl("p", {
      text: `Checked the first 200 words locally in ${this.scannedCount} Markdown notes under ${this.folderPath}. The AI provider received excerpts only from ${this.notes.length} likely matching notes. Similarity must be greater than 95%.`
    });

    if (!this.pairs.length) {
      contentEl.createEl("p", { text: "No note pairs were above 95% similarity." });
      return;
    }

    const list = contentEl.createDiv({ cls: "oao-duplicate-list" });
    for (const pair of this.pairs) {
      const item = list.createDiv({ cls: "oao-duplicate-item" });
      item.createEl("strong", { text: `${(pair.similarity * 100).toFixed(1)}% similarity` });
      item.createEl("div", { text: this.notes[pair.firstIndex]?.path ?? "Unknown note" });
      item.createEl("div", { text: this.notes[pair.secondIndex]?.path ?? "Unknown note" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
