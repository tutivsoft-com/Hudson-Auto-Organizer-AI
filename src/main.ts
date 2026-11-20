import { FileSystemAdapter, Menu, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import { AutoOrganizerSettingTab } from "./settings-tab";
import { AutoOrganizeResultsModal, DuplicateResultsModal, FolderPickerModal, InstructionModal } from "./modals";
import { findFolderByPath, isExcludedPath, listFolders, matchFolderPhrase, normalizePath, parentFolderPath } from "./folder-utils";
import { commandIncludesAttachments, createRulesTemplate, extractDestinationPhrase, parseRules, resolveLearnedMove, resolveRule } from "./rules";
import { suggestDestination } from "./openrouter";
import { getAiConnection } from "./ai-connection";
import { OPENAI_MODEL, providerName } from "./ai-provider";
import { initializeMatomo, matomoFor } from "./matomo-plugin";
import { PluginSupport } from "./plugin-support";
import { rankPopularDestinations } from "./move-context";
import { findDuplicatePairs, findLikelyDuplicatePairs, readFirstWordsFromDisk } from "./duplicate-detection";
import { classifyAutoOrganizeItems, AutoOrganizeSuggestion } from "./auto-organize";
import { firstWords } from "./text-limits";
import { actionTarget, captureLines, withoutFiledEntries, executePlan, OrganizePlan, PlanAction } from "./organize-plan";
import { ReviewOptions } from "./plan-modal";
import { openReviewWindow, OrganizerReviewView, REVIEW_VIEW_TYPE } from "./review-view";
import { isTrashPath, TRASH_FOLDER_NAME, trashDestination } from "./trash";
import { diagnostics } from "./diagnostics";
import { AppendOperation, AutoOrganizerSettings, DEFAULT_SETTINGS, LearnedMove, MoveHistoryEntry, MoveOperation } from "./types";
import { registerBillingPersister, signOutBillingAccount } from "./constance-account";
import { AUTO_ORGANIZER_APP_ID, syncEntitlements } from "./constance-v2";
import { digest, jobId, recoverNative, reserveNative, NativeHost } from "./native-operations";
import { runMeteredOperation } from "./usage-meter";
import { sourcePreview } from "./source-preview";
import { createDestinationContext, sourceFileExcerpt, sourceLineContext } from "./destination-context";
import { DEFAULT_POLICY, OrganizationPolicy, validatePolicy, isSafeVaultPath, within, entryAlreadyPresent, entryFilePath, isEntryTarget, isFilingFolder, isAppendNote } from "./organization-policy";

import { compileOrganizationPolicy } from "./policy-compiler";

const HISTORY_LIMIT = 30;
const EXAMPLE_LIMIT = 12;
const AUTO_ROUTE_CONFIDENCE = 0.72;
const DUPLICATES_FOLDER_NAME = "Duplicates";
const PROCESSED_FOLDER_NAME = "_Auto Organizer Processed";
const LOG_FOLDER_NAME = "ZZZ_LOGS/Auto Organizer Logs";

export default class AutoOrganizerPlugin extends Plugin {
  settings: AutoOrganizerSettings = { ...DEFAULT_SETTINGS };
  private programmaticMovePaths = new Set<string>();
  private migratedLegacySettings = false;
  private activePlan: OrganizePlan | null = null;
  private organizationRevision = 0;
  support!: PluginSupport;

  get policy(): OrganizationPolicy {
    if (this.settings.organizationNeedsSetup) throw new Error("Choose Use default or save your own organization rules in Hudson settings before organizing.");
    return this.settings.organizationMode === "custom" && this.settings.organizationPolicy ? this.settings.organizationPolicy : DEFAULT_POLICY;
  }

  private organizationReady(): boolean {
    if (!this.settings.organizationNeedsSetup) return true;
    new Notice("Choose Use default or save your own organization rules in Hudson settings before organizing.");
    return false;
  }

  async useDefaultOrganization(): Promise<void> {
    if (this.activePlan) throw new Error("Close the current review before changing organization rules.");
    this.organizationRevision++;
    this.settings.organizationMode = "default";
    this.settings.organizationNeedsSetup = false;
    this.settings.lineDestinationFolder = DEFAULT_POLICY.appendRoots.join(", ");
    await this.saveSettings();
  }

  async saveOrganizationRules(): Promise<void> {
    if (this.activePlan) throw new Error("Close the current review before changing organization rules.");
    const revision = ++this.organizationRevision;
    const instructions = this.settings.organizationInstructions;
    const { apiKey, model, provider } = await getAiConnection(this.app, this.settings, this.manifest.dir);
    const policy = await compileOrganizationPolicy(apiKey, model, provider, instructions, listFolders(this.app.vault.getRoot()).map((folder) => folder.path));
    if (revision !== this.organizationRevision || this.activePlan || this.settings.organizationInstructions !== instructions) throw new Error("The rules or review changed while saving. Try saving again.");
    this.settings.organizationPolicy = policy;
    this.settings.organizationMode = "custom";
    this.settings.organizationNeedsSetup = false;
    this.settings.lineDestinationFolder = policy.appendRoots.join(", ");
    await this.saveSettings();
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    if (!this.settings.constanceDeviceId) {
      this.settings.constanceDeviceId = `auto-organizer-${crypto.randomUUID()}`;
      await this.saveSettings();
    }
    registerBillingPersister(this.settings, () => this.saveSettings());
    this.support = new PluginSupport(this);
    this.support.start();
    initializeMatomo(this);
    this.addSettingTab(new AutoOrganizerSettingTab(this.app, this));
    this.registerReviewView();
    this.registerCommands();
    this.registerContextMenus();
    this.addCommand({
      id: "auto-organize-active-folder",
      name: "Auto organize a folder",
      callback: () => this.chooseFolderToAutoOrganize()
    });
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleVaultRename(file, oldPath)));
    this.addRibbonIcon("folder-open", "Organize current note", () => {
      const file = this.app.workspace.getActiveFile();
      if (file) this.openInstructionModal([file]);
      else new Notice("Open a note or choose a file first.");
    });
    if (this.settings.billingAccountLinked) void recoverNative(this.nativeHost).then(() => this.syncBillingBalance()).catch(error => diagnostics.failure("billing.startup-refresh", error));
  }

  async loadSettings(): Promise<void> {
    let saved = await this.loadData() as Partial<AutoOrganizerSettings> | null;
    if (!saved) {
      const configDir = (this.app.vault as unknown as { configDir?: string }).configDir || ".obsidian";
      const oldDataPath = normalizePath(`${configDir}/plugins/obsidian-ai-auto-organizer/data.json`);
      try {
        if (await this.app.vault.adapter.exists(oldDataPath)) {
          saved = JSON.parse(await this.app.vault.adapter.read(oldDataPath)) as Partial<AutoOrganizerSettings>;
          this.migratedLegacySettings = true;
        }
      } catch {
        new Notice("Previous organizer settings could not be read. The original settings file was left untouched.");
      }
    }
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(saved ?? {}),
      organizationMode: saved?.organizationMode === "custom" ? "custom" : "default",
      organizationInstructions: typeof saved?.organizationInstructions === "string" ? saved.organizationInstructions : "",
      organizationPolicy: null,
      organizationNeedsSetup: Boolean(saved && (!saved.organizationMode || saved.organizationNeedsSetup)),
      learnedMoves: Array.isArray(saved?.learnedMoves) ? saved.learnedMoves : [],
      history: Array.isArray(saved?.history) ? saved.history : [],
      lastAutoOrganizeDeferred: Array.isArray(saved?.lastAutoOrganizeDeferred) ? saved.lastAutoOrganizeDeferred : [],
      lastAutoOrganizeReportPath: typeof saved?.lastAutoOrganizeReportPath === "string" ? saved.lastAutoOrganizeReportPath : "",
      lastAutoOrganizeSourceFolder: typeof saved?.lastAutoOrganizeSourceFolder === "string" ? saved.lastAutoOrganizeSourceFolder : "",
      aiProvider: saved?.aiProvider === "openrouter" ? "openrouter" : "openai",
      openaiModel: typeof saved?.openaiModel === "string" && saved.openaiModel.trim() ? saved.openaiModel.trim() : OPENAI_MODEL,
      organizeWorkflow: saved?.organizeWorkflow === "automatic" ? "automatic" : "preview",
      settingsMode: saved?.settingsMode === "advanced" ? "advanced" : "simple",
      debugLogging: saved?.debugLogging === true,
      billingEmail: typeof saved?.billingEmail === "string" ? saved.billingEmail : "",
      billingAccessToken: typeof saved?.billingAccessToken === "string" ? saved.billingAccessToken : "",
      billingRefreshToken: typeof saved?.billingRefreshToken === "string" ? saved.billingRefreshToken : "",
      billingAccessTokenExpiresAt: Number.isFinite(saved?.billingAccessTokenExpiresAt) ? Number(saved?.billingAccessTokenExpiresAt) : 0,
      billingAccountLinked: saved?.billingAccountLinked === true,
      freeUsesRemaining: Number.isSafeInteger(saved?.freeUsesRemaining) && Number(saved?.freeUsesRemaining) >= 0 ? Number(saved?.freeUsesRemaining) : null,
      purchasedUses: Number.isSafeInteger(saved?.purchasedUses) && Number(saved?.purchasedUses) >= 0 ? Number(saved?.purchasedUses) : null,
      billingRegistrationPending: saved?.billingRegistrationPending === true,
      billingV2InstallationId: typeof saved?.billingV2InstallationId === "string" ? saved.billingV2InstallationId : "",
      billingV2InstallationToken: typeof saved?.billingV2InstallationToken === "string" ? saved.billingV2InstallationToken : "",
      billingV2InstallationOwner: typeof saved?.billingV2InstallationOwner === "string" ? saved.billingV2InstallationOwner : "",
      billingV2Installations: saved?.billingV2Installations && typeof saved.billingV2Installations === "object" ? saved.billingV2Installations : {},
      constanceDeviceId: typeof saved?.constanceDeviceId === "string" ? saved.constanceDeviceId : "",
      operationJournal: Array.isArray(saved?.operationJournal) ? saved.operationJournal : []
    };
    if (saved?.organizationMode === "custom") {
      try { this.settings.organizationPolicy = validatePolicy(saved.organizationPolicy); }
      catch { this.settings.organizationNeedsSetup = true; }
    }
    if (!this.settings.organizationNeedsSetup) this.settings.lineDestinationFolder = this.policy.appendRoots.join(", ");
    if (this.migratedLegacySettings) {
      await this.saveSettings();
      new Notice("Organizer settings were copied to the new plugin. The previous settings file remains untouched.");
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private get nativeHost(): NativeHost {
    return { app: this.app, settings: this.settings, persistNative: () => this.saveSettings(), syncBalance: () => this.syncBillingBalance() };
  }

  async syncBillingBalance(): Promise<void> {
    await syncEntitlements(this.settings, () => this.saveSettings());
  }

  async signOutBilling(): Promise<void> {
    await signOutBillingAccount({
      state: this.settings,
      appId: AUTO_ORGANIZER_APP_ID,
      installationId: this.settings.constanceDeviceId,
      persist: () => this.saveSettings(),
      syncBalance: () => this.syncBillingBalance()
    });
  }

  private async runMeteredAi<T>(file: TFile, operation: string, action: () => Promise<T>): Promise<T> {
    if (!this.settings.billingAccountLinked || !this.settings.billingAccessToken) {
      throw new Error("Connect your account in Hudson Auto Organizer AI settings before using AI features.");
    }
    const original = await this.app.vault.cachedRead(file);
    const sourceDigest = await digest(original);
    return runMeteredOperation(
      () => reserveNative(this.nativeHost, AUTO_ORGANIZER_APP_ID, jobId(), `${file.path}\n${sourceDigest}`, `ai:${operation}`, { notes: 1 }),
      async (reservation) => { await reservation.markWriting([{ path: file.path, after: sourceDigest }]); },
      action
    );
  }

  async openRulesFile(): Promise<void> {
    const path = this.settings.rulesFilePath.replace(/\\/g, "/").trim();
    if (!path || path.startsWith("/") || path.split("/").includes("..")) {
      new Notice("Choose a rules file path inside this vault.");
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      new Notice("The rules path points to a folder. Choose a Markdown file path.");
      return;
    }
    const file = existing instanceof TFile
      ? existing
      : await this.app.vault.create(path, createRulesTemplate());
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async undoMove(id?: string, reviewPlan?: OrganizePlan): Promise<boolean> {
    if (this.activePlan && this.activePlan !== reviewPlan) {
      new Notice("Close the current review before undoing a run.");
      return false;
    }
    const entry = id
      ? this.settings.history.find((item) => item.id === id)
      : this.settings.history[0];
    if (!entry) {
      new Notice("There is no move to undo.");
      return false;
    }

    const planned: Array<{ file: TFile; from: string; to: string }> = [];
    const moves = [...entry.moves];
    for (const pending of entry.pendingMoves ?? []) {
      if (moves.some((move) => move.fromPath === pending.fromPath && move.toPath === pending.toPath)) continue;
      const from = this.app.vault.getAbstractFileByPath(pending.fromPath);
      const to = this.app.vault.getAbstractFileByPath(pending.toPath);
      if (from instanceof TFile && !to) continue;
      if (!from && to instanceof TFile) moves.push(pending);
      else { new Notice("A recorded move has conflicting paths. Keep both files and review its history before undoing."); return false; }
    }
    for (const move of moves.reverse()) {
      const file = this.app.vault.getAbstractFileByPath(move.toPath);
      if (!(file instanceof TFile)) {
        new Notice(`Cannot undo because ${move.toPath} is no longer at the moved path.`);
        return false;
      }
      const conflict = this.app.vault.getAbstractFileByPath(move.fromPath);
      if (conflict && conflict.path !== file.path) {
        new Notice(`Cannot undo because ${move.fromPath} is already in use.`);
        return false;
      }
      planned.push({ file, from: move.toPath, to: move.fromPath });
    }

    const sourceTargets = new Map<string, TFile>();
    for (const edit of entry.sourceEdits || []) {
      const path = moves.find((move) => move.fromPath === edit.sourcePath)?.toPath || edit.sourcePath;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) { new Notice("A filed source is missing. Undo stopped."); return false; }
      const current = await this.app.vault.read(file);
      if (current !== edit.after && current !== edit.before) { new Notice("A filed source changed after filing. Undo stopped to preserve your edits."); return false; }
      sourceTargets.set(edit.sourcePath, file);
    }

    const appendTargets = new Map<string, TFile>();
    for (const append of entry.appends ?? []) {
      const target = this.app.vault.getAbstractFileByPath(append.targetPath);
      if (!(target instanceof TFile) || target.extension.toLocaleLowerCase() !== "md") {
        new Notice(`Cannot undo because ${append.targetPath} is missing.`);
        return false;
      }
      const current = await this.app.vault.cachedRead(target);
      const first = current.indexOf(append.text);
      if (first < 0 || current.indexOf(append.text, first + append.text.length) >= 0) {
        new Notice(`Cannot safely undo because the appended text in ${append.targetPath} has changed or is ambiguous.`);
        return false;
      }
      appendTargets.set(append.targetPath, target);
    }

    const createdNoteContents = new Map<string, string>();
    const undoneCreations: Array<{ from: string; to: string }> = [];
    for (const note of entry.createdNotes || []) {
      if (!isSafeVaultPath(note.targetPath)) { new Notice("A created-entry record has an invalid destination. Undo stopped."); return false; }
      const target = this.app.vault.getAbstractFileByPath(note.targetPath);
      if (!target) continue; // A recorded create can have stopped before its write.
      if (!(target instanceof TFile) || await this.app.vault.cachedRead(target) !== note.text) {
        new Notice("A created entry changed after filing. Undo stopped to preserve it."); return false;
      }
      const to = note.undoTrashPath || trashDestination(crypto.randomUUID(), note.targetPath);
      if (!isTrashPath(to)) { new Notice("A created-entry recovery path is invalid. Undo stopped."); return false; }
      if (this.app.vault.getAbstractFileByPath(to)) { new Notice("Undo trash path is occupied."); return false; }
      await this.ensureFolder(parentFolderPath(to));
      createdNoteContents.set(note.targetPath, note.text);
      note.undoTrashPath = to;
      undoneCreations.push({ from: note.targetPath, to });
      planned.push({ file: target, from: note.targetPath, to });
    }
    if (undoneCreations.length) await this.saveSettings();

    const completed: Array<{ file: TFile; from: string; to: string }> = [];
    const removedAppends: AppendOperation[] = [];
    const restoredSources: Array<{ file: TFile; after: string }> = [];
    try {
      for (const operation of planned) {
        if (createdNoteContents.has(operation.from) && await this.app.vault.cachedRead(operation.file) !== createdNoteContents.get(operation.from)) throw new Error("A created entry changed during Undo.");
        this.programmaticMovePaths.add(operation.from);
        try {
          await this.app.fileManager.renameFile(operation.file, operation.to);
        } catch (error) {
          this.programmaticMovePaths.delete(operation.from);
          throw error;
        }
        completed.push(operation);
      }
      for (const edit of entry.sourceEdits || []) {
        const file = sourceTargets.get(edit.sourcePath)!;
        await this.app.vault.process(file, (current) => {
          if (current !== edit.after && current !== edit.before) throw new Error("Source changed during Undo.");
          restoredSources.push({ file, after: current });
          return edit.before;
        });
      }
      for (const append of entry.appends ?? []) {
        const target = appendTargets.get(append.targetPath);
        if (!target) throw new Error("An appended note is no longer available.");
        await this.app.vault.process(target, (current) => {
          const first = current.indexOf(append.text);
          if (first < 0 || current.indexOf(append.text, first + append.text.length) >= 0) {
            throw new Error(`The appended text in ${append.targetPath} changed during undo.`);
          }
          return current.slice(0, first) + current.slice(first + append.text.length);
        });
        removedAppends.push(append);
      }
    } catch (error) {
      diagnostics.failure("organizer.undo", error);
      for (const restored of restoredSources.reverse()) await this.app.vault.modify(restored.file, restored.after).catch(() => undefined);
      for (const append of [...removedAppends].reverse()) {
        const target = appendTargets.get(append.targetPath);
        if (target) await this.app.vault.append(target, append.text).catch(() => undefined);
      }
      for (const operation of completed.reverse()) {
        const file = this.app.vault.getAbstractFileByPath(operation.to);
        if (file instanceof TFile) {
          this.programmaticMovePaths.add(file.path);
          await this.app.fileManager.renameFile(file, operation.from).catch(() => undefined);
        }
      }
      new Notice("Undo could not finish. Files moved before the error were restored where possible.");
      return false;
    }

    let cleanupSkipped = 0;
    for (const path of [...(entry.createdFolders ?? [])].sort((a, b) => b.length - a.length)) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (path === TRASH_FOLDER_NAME || (this.settings.organizationPolicy || DEFAULT_POLICY).filingFolders.includes(path) || !(folder instanceof TFolder) || folder.children.length !== 0) continue;
      try { await this.app.vault.adapter.rmdir(path, false); }
      catch (error) { cleanupSkipped++; diagnostics.failure("organizer.undo-folder-cleanup", error); }
    }
    this.settings.history = this.settings.history.filter((item) => item.id !== entry.id);
    await this.saveSettings();
    if (entry.reportPath) {
      const report = this.app.vault.getAbstractFileByPath(entry.reportPath);
      if (report instanceof TFile) {
        const stamp = new Date().toISOString();
        await this.app.vault.append(report, `\n\n## Undo\nUndone at ${stamp}.\n${undoneCreations.map((item) => `Created entry moved to Deleted: ${item.from} -> ${item.to}`).join("\n")}\n`).catch(() => undefined);
      }
    }
    new Notice(cleanupSkipped ? "Last move undone. Empty recovery folders were kept." : "Last move undone.");
    return true;
  }

  private async loadRules(): Promise<ReturnType<typeof parseRules>> {
    const path = this.settings.rulesFilePath.replace(/\\/g, "/").trim();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return this.policy.aliases;
    try {
      return [...this.policy.aliases, ...parseRules(await this.app.vault.cachedRead(file)).filter((rule) => isFilingFolder(rule.destination, this.policy))];
    } catch {
      return [];
    }
  }

  private registerCommands(): void {
    this.addCommand({ id: "preview-folder", name: "Preview folder changes (dry run)", callback: () => {
      new FolderPickerModal(this.app, listFolders(this.app.vault.getRoot()), "Choose a folder to preview", (folder) => void this.autoOrganizeFolder(folder, "full", true)).open();
    } });
    this.addCommand({ id: "file-lines-manually", name: "File active note line by line manually", callback: () => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.manuallyProcessFiles([file], true);
      else new Notice("Open a note first.");
    } });
    this.addCommand({
      id: "organize-active-note",
      name: "Organize active note with AI",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) this.openInstructionModal([file]);
        else new Notice("Open a note or choose a file first.");
      }
    });
    this.addCommand({
      id: "choose-folder-for-active-note",
      name: "Choose folder for active note",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) this.openFolderPicker([file]);
        else new Notice("Open a note or choose a file first.");
      }
    });
    this.addCommand({
      id: "undo-last-move",
      name: "Undo last organizer move",
      callback: () => void this.undoMove()
    });
    this.addCommand({
      id: "open-rules-file",
      name: "Open Auto Organizer rules file",
      callback: () => void this.openRulesFile()
    });
  }

  private registerReviewView(): void {
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new OrganizerReviewView(leaf));
    this.register(() => this.app.workspace.detachLeavesOfType(REVIEW_VIEW_TYPE));
  }

  private async openReviewSurface(plan: OrganizePlan, options: ReviewOptions): Promise<void> {
    try { await openReviewWindow(this.app, plan, options); }
    catch (error) { diagnostics.failure("review.open", error); options.release(); new Notice("The organizer window could not open. Try again from the file or folder menu."); }
  }

  private registerContextMenus(): void {
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (Array.isArray((file as TFolder).children)) this.addFolderMenuItems(menu, file as TFolder);
      else if (file instanceof TFile) this.addFileMenuItems(menu, [file]);
    }));
    this.registerEvent(this.app.workspace.on("files-menu", (menu, files) => {
      const selected = files.filter((file): file is TFile => file instanceof TFile);
      if (selected.length) this.addFileMenuItems(menu, selected);
      else {
        const folders = files.filter((file): file is TFolder => Array.isArray((file as TFolder).children));
        if (folders.length === 1) this.addFolderMenuItems(menu, folders[0]);
      }
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, _editor, info) => {
      if (info.file instanceof TFile) this.addFileMenuItems(menu, [info.file]);
    }));
  }

  private addFileMenuItems(menu: Menu, files: TFile[]): void {
    menu.addItem((item) => item.setSection("hudson-auto-organizer-ai").setTitle("Hudson: Choose destinations manually").setIcon("list-checks")
      .onClick(() => void this.manuallyProcessFiles(files)));
    if (files.length === 1 && files[0].extension.toLowerCase() === "md") {
      menu.addItem((item) => item.setSection("hudson-auto-organizer-ai").setTitle("Hudson: File lines manually...").setIcon("list")
        .onClick(() => void this.manuallyProcessFiles(files, true)));
    }
    const selected = [...new Map(files.map((file) => [file.path, file])).values()];
    if (selected.length === 1) {
      menu.addItem((item) => item
        .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Organize with AI")
        .setIcon("folder-open")
        .onClick(() => this.openInstructionModal([selected[0]])));
      menu.addItem((item) => item
        .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Move to folder...")
        .setIcon("folder")
        .onClick(() => this.openFolderPicker(selected)));
      return;
    }

    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle(`Hudson: Move ${selected.length} selected files to folder...`)
      .setIcon("folder")
      .onClick(() => this.openFolderPicker(selected)));
    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle(`Hudson: Organize ${selected.length} selected files with AI`)
      .setIcon("sparkles")
      .onClick(() => this.openInstructionModal(selected, `Organize these ${selected.length} files`)));
  }

  private addFolderMenuItems(menu: Menu, folder: TFolder): void {
    menu.addItem((item) => item.setSection("hudson-auto-organizer-ai").setTitle("Hudson: Preview changes (dry run)").setIcon("scan-eye")
      .onClick(() => void this.autoOrganizeFolder(folder, "full", true)));
    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Auto organize this folder")
      .setIcon("sparkles")
      .onClick(() => void this.autoOrganizeFolder(folder, "full")));
    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Preview deleting exact duplicate copies")
      .setIcon("copy")
      .onClick(() => void this.autoOrganizeFolder(folder, "duplicates", true)));
    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Organize non-duplicates here")
      .setIcon("folder-open")
      .onClick(() => void this.autoOrganizeFolder(folder, "nonduplicates")));
    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Review deferred items from last run")
      .setIcon("list-checks")
      .onClick(() => this.openLastDeferredReview()));
    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Undo last Auto Organize run")
      .setIcon("undo-2")
      .onClick(() => {
        const last = this.settings.history.find((entry) => entry.instruction.startsWith("Auto organize:"));
        if (last) void this.undoMove(last.id);
        else new Notice("There is no Auto Organize run to undo.");
      }));
    menu.addItem((item) => item
      .setSection("hudson-auto-organizer-ai").setTitle("Hudson: Compare similar notes with AI (read only)")
      .setIcon("copy")
      .onClick(() => void this.findDuplicatesInFolder(folder)));
  }

  private chooseFolderToAutoOrganize(): void {
    new FolderPickerModal(this.app, listFolders(this.app.vault.getRoot()), "Choose a folder to auto organize", (folder) => {
      void this.autoOrganizeFolder(folder, "full");
    }).open();
  }

  private openLastDeferredReview(): void {
    if (!this.settings.lastAutoOrganizeDeferred.length) {
      new Notice("There are no deferred Auto Organize items to review.");
      return;
    }
    new AutoOrganizeResultsModal(this.app, {
      sourceFolder: this.settings.lastAutoOrganizeSourceFolder || "Vault root",
      duplicateCount: 0,
      fileMoveCount: 0,
      lineRouteCount: 0,
      deferred: this.settings.lastAutoOrganizeDeferred,
      reportPath: this.settings.lastAutoOrganizeReportPath || "No run log is available",
      onOpenPath: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void this.app.workspace.getLeaf(true).openFile(file);
      }
    }).open();
  }

  private isAutoOrganizerInternalPath(path: string): boolean {
    return path === "ZZZ_LOGS" || path.startsWith("ZZZ_LOGS/") || isTrashPath(path) || path === this.policy.archiveFolder || path.startsWith(`${this.policy.archiveFolder}/`) || path.split("/").some((segment) => [DUPLICATES_FOLDER_NAME, PROCESSED_FOLDER_NAME, "_Auto Organizer Logs"].includes(segment));
  }

  private isLineDestinationPath(path: string): boolean {
    return this.policy.appendRoots.some((root) => within(path, root))
      || this.policy.filingFolders.some((root) => within(path, root))
      || this.policy.referencePaths.some((root) => within(path, root));
  }

  private collectMarkdownFiles(folder: TFolder): TFile[] {
    const result: TFile[] = [];
    const visit = (current: TFolder): void => {
      for (const child of current.children) {
        if (child instanceof TFolder) {
          if (!isExcludedPath(child.path, this.settings.excludedFolders) && !this.isAutoOrganizerInternalPath(child.path) && !this.isLineDestinationPath(child.path)) visit(child);
        } else if (child instanceof TFile && child.extension.toLocaleLowerCase() === "md" &&
          !isExcludedPath(child.path, this.settings.excludedFolders) && !this.isAutoOrganizerInternalPath(child.path) && !this.isLineDestinationPath(child.path)) {
          result.push(child);
        }
      }
    };
    visit(folder);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async ensureFolder(path: string, createdFolders?: Set<string>): Promise<TFolder> {
    const normalized = path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return existing;
    if (existing) throw new Error(`A non-folder item already exists at ${normalized}.`);
    const parent = parentFolderPath(normalized);
    if (parent) await this.ensureFolder(parent, createdFolders);
    await this.app.vault.createFolder(normalized);
    createdFolders?.add(normalized);
    const created = this.app.vault.getAbstractFileByPath(normalized);
    if (!(created instanceof TFolder)) throw new Error(`Could not create folder ${normalized}.`);
    return created;
  }

  private async applyMoves(operations: MoveOperation[], createdFolders?: Set<string>): Promise<MoveOperation[]> {
    const unique = [...new Map(operations.map((item) => [item.fromPath, item])).values()];
    const planned: Array<{ file: TFile; operation: MoveOperation }> = [];
    for (const operation of unique) {
      const file = this.app.vault.getAbstractFileByPath(operation.fromPath);
      if (!(file instanceof TFile)) throw new Error(`Cannot find source file ${operation.fromPath}.`);
      const conflict = this.app.vault.getAbstractFileByPath(operation.toPath);
      if (conflict && normalizePath(conflict.path) !== normalizePath(operation.fromPath)) throw new Error(`A file already exists at ${operation.toPath}.`);
      const destination = parentFolderPath(operation.toPath);
      if (destination) await this.ensureFolder(destination, createdFolders);
      planned.push({ file, operation });
    }
    const completed: MoveOperation[] = [];
    try {
      for (const { file, operation } of planned) {
        this.programmaticMovePaths.add(operation.fromPath);
        try {
          await this.app.fileManager.renameFile(file, operation.toPath);
        } catch (error) {
          this.programmaticMovePaths.delete(operation.fromPath);
          throw error;
        }
        completed.push(operation);
      }
    } catch (error) {
      for (const operation of [...completed].reverse()) {
        const file = this.app.vault.getAbstractFileByPath(operation.toPath);
        if (file instanceof TFile) {
          this.programmaticMovePaths.add(file.path);
          await this.app.fileManager.renameFile(file, operation.fromPath).catch(() => undefined);
        }
      }
      throw error;
    }
    return completed;
  }

  private newPlan(title: string): OrganizePlan {
    const folders = this.policy.filingFolders.filter((path) => !isExcludedPath(path, this.settings.excludedFolders));
    const categories = this.app.vault.getMarkdownFiles().filter((file) =>
      isAppendNote(file.path, this.policy) && !isExcludedPath(file.path, this.settings.excludedFolders) && !this.isAutoOrganizerInternalPath(file.path));
    return { id: crypto.randomUUID(), title, policy: structuredClone(this.policy), actions: [], snapshots: {}, previews: {}, folders,
      categories: categories.map((file) => file.path), archives: {}, archived: new Set(), deferred: [], moves: [], appends: [], createdNotes: [] };
  }

  private async fingerprint(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("Source is missing. Create a new preview.");
    return digest(file.extension.toLowerCase() === "md" ? await this.app.vault.read(file) : await this.app.vault.readBinary(file));
  }

  private addFileChoice(plan: OrganizePlan, path: string, reason = "Choose a destination yourself.", destination = "", selected = false): PlanAction {
    const action: PlanAction = { id: crypto.randomUUID(), kind: "file", sourcePath: path, destination, reason, selected, status: "pending" };
    plan.actions.push(action);
    return action;
  }

  private availablePlanPath(plan: OrganizePlan, path: string): string {
    const reserved = new Set([...plan.actions.filter((a) => a.destination).map(actionTarget), ...Object.values(plan.archives)]);
    const dot = path.lastIndexOf(".");
    const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
    const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
    let candidate = path;
    for (let suffix = 2; this.app.vault.getAbstractFileByPath(candidate) || reserved.has(candidate); suffix++) candidate = `${stem} (${suffix})${extension}`;
    return candidate;
  }

  private async splitPlanFile(plan: OrganizePlan, path: string, sourceFolder = parentFolderPath(path)): Promise<void> {
    if (plan.actions.some((a) => a.sourcePath === path && a.status === "done")) throw new Error("Some entries are already filed. Finish or close this review first.");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") throw new Error("Choose a Markdown note.");
    const content = await this.app.vault.read(file);
    if (await digest(content) !== plan.snapshots[path]) throw new Error("Source changed. Create a new preview.");
    const captures = captureLines(content);
    if (!captures.lines.length) throw new Error("No plain capture lines were found. Move or edit this note as a whole file.");
    plan.actions = plan.actions.filter((action) => action.sourcePath !== path);
    delete plan.archives[path];
    for (const line of captures.lines) plan.actions.push({ id: crypto.randomUUID(), kind: "line", sourcePath: path,
      destination: "", selected: false, status: "pending", reason: "Choose a category note for this line.", ...line });
    if (captures.canArchive) {
      plan.archives[path] = this.availablePlanPath(plan, trashDestination(plan.id, path));
    }
  }

  private planDestinationContext(plan: OrganizePlan, folders: string[] = []) {
    const allowedFolders = new Set(folders);
    const folderFiles = folders.length ? this.app.vault.getMarkdownFiles().filter((file) =>
      allowedFolders.has(parentFolderPath(file.path) || "/") && !this.policy.referencePaths.some((root) => within(file.path, root)) && !isExcludedPath(file.path, this.settings.excludedFolders) && !this.isAutoOrganizerInternalPath(file.path)
    ).map((file) => ({ path: file.path, folderPath: parentFolderPath(file.path) || "/" })) : [];
    return createDestinationContext(plan.categories, async (path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || this.policy.referencePaths.some((root) => within(path, root)) || isExcludedPath(path, this.settings.excludedFolders) || this.isAutoOrganizerInternalPath(path)) return "";
      try { return await this.app.vault.cachedRead(file); }
      catch (error) { diagnostics.failure("destination_context.read", error); return ""; }
    }, folderFiles);
  }

  private async suggestPlanLines(plan: OrganizePlan, status: (text: string) => void, stopped: () => boolean): Promise<void> {
    const lines = plan.actions.filter((action) => action.kind === "line" && action.status === "pending" && !action.destination);
    if (!lines.length || stopped()) return;
    const categories = plan.categories.filter((path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile && isAppendNote(path, this.policy) && !isExcludedPath(path, this.settings.excludedFolders) && !this.isAutoOrganizerInternalPath(path);
    });
    if (!categories.length) throw new Error("No eligible category files were found. Add Markdown category files under your configured append folders, then start a fresh preview.");
    const sources = new Map<string, string>();
    for (const path of new Set(lines.map((line) => line.sourcePath))) {
      if (stopped()) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error("Source file is missing.");
      const content = await this.app.vault.read(file);
      if (await digest(content) !== plan.snapshots[path]) throw new Error("Source changed since preview. Start a new review before suggesting lines.");
      sources.set(path, plan.sourceEdits?.find((edit) => edit.sourcePath === path)?.before ?? content);
    }
    const source = this.app.vault.getAbstractFileByPath(lines[0].sourcePath);
    if (!(source instanceof TFile)) throw new Error("Source file is missing.");
    const { apiKey, model, provider } = await getAiConnection(this.app, this.settings, this.manifest.dir);
    if (stopped()) return;
    status(`Suggesting destination files for ${lines.length} lines...`);
    const suggestions = await this.runMeteredAi(source, "Suggest line destinations", () => classifyAutoOrganizeItems(apiKey, model,
      lines.map((line, index) => ({ index, path: line.sourcePath, lineNumber: line.lineNumber, lineEndNumber: line.lineEndNumber, excerpt: line.lineEndNumber && line.lineEndNumber > line.lineNumber! ? sourceFileExcerpt(line.text!) : firstWords(line.text!), sourceContext: sourceLineContext(sources.get(line.sourcePath)!, line.lineNumber!), nonEmptyLines: line.text!.split(/\r?\n/u).filter((text) => text.trim()).length })),
      plan.folders.filter((path) => [this.policy.capsuleFolder, this.policy.archiveFolder].includes(path)), categories, stopped, provider, this.planDestinationContext({ ...plan, categories }), true, this.policy));
    this.applyLineSuggestions(plan, lines, suggestions, sources);
  }

  applyPolicyToPlan(plan: OrganizePlan): void {
    plan.policy = structuredClone(this.policy);
    plan.folders = this.policy.filingFolders.filter((path) => !isExcludedPath(path, this.settings.excludedFolders));
    plan.categories = this.app.vault.getMarkdownFiles().filter((file) => isAppendNote(file.path, this.policy) && !isExcludedPath(file.path, this.settings.excludedFolders) && !this.isAutoOrganizerInternalPath(file.path)).map((file) => file.path);
    for (const [path] of Object.entries(plan.archives)) if (!plan.archived.has(path)) plan.archives[path] = trashDestination(plan.id, path);
    for (const action of plan.actions) {
      if (action.status !== "pending") continue;
      if (action.kind === "duplicate" && !action.duplicateVerified) { action.kind = "file"; delete action.keeperPath; }
      const invalid = action.kind === "file" && !plan.folders.includes(action.destination)
        || action.kind === "line" && (!action.entryMode || action.entryMode === "append") && !plan.categories.includes(action.destination);
      if (invalid && action.destination) {
        action.destination = ""; action.selected = false; delete action.confidence;
        action.reason = "Previous destination is outside the current rules. Choose an allowed destination or request new suggestions.";
      }
    }
  }

  private setEntryMode(plan: OrganizePlan, action: PlanAction, mode: "append" | "capsule" | "archive"): void {
    if (action.kind !== "line" || action.status !== "pending") return;
    action.entryMode = mode;
    action.selected = false;
    action.destination = mode === "append" ? "" : this.availablePlanPath(plan, entryFilePath(action.sourcePath, action.lineNumber || 1, action.lineEndNumber || action.lineNumber || 1, mode === "capsule" ? this.policy.capsuleFolder : this.policy.archiveFolder));
  }

  private mergeEntrySpan(plan: OrganizePlan, entries: PlanAction[], content: string): PlanAction {
    const ordered = [...entries].sort((a, b) => (a.lineNumber || 0) - (b.lineNumber || 0));
    const first = ordered[0];
    const last = ordered.at(-1)!;
    const end = last.lineEndNumber || last.lineNumber!;
    const ids = new Set(ordered.map((entry) => entry.id));
    if (ordered.some((entry) => entry.sourcePath !== first.sourcePath || entry.kind !== "line" || entry.status !== "pending")
      || plan.actions.some((entry) => entry.sourcePath === first.sourcePath && entry.lineNumber && entry.lineNumber >= first.lineNumber! && entry.lineNumber <= end && !ids.has(entry.id))) {
      throw new Error("Choose consecutive pending entries from one source, including all entries between them.");
    }
    first.text = content.split(/\r?\n/u).slice(first.lineNumber! - 1, end).join("\n");
    first.lineEndNumber = end;
    first.entryMode = "append"; first.destination = ""; first.selected = false;
    plan.actions = plan.actions.filter((entry) => !ids.has(entry.id) || entry === first);
    return first;
  }

  private async groupPlanLines(plan: OrganizePlan, ids: Set<string>): Promise<void> {
    const entries = plan.actions.filter((entry) => ids.has(entry.id));
    if (entries.length < 2) throw new Error("Select at least two related lines from one source.");
    const file = this.app.vault.getAbstractFileByPath(entries[0].sourcePath);
    if (!(file instanceof TFile)) throw new Error("Source is missing.");
    const content = await this.app.vault.read(file);
    if (await digest(content) !== plan.snapshots[file.path]) throw new Error("Source changed. Create a new preview.");
    const grouped = this.mergeEntrySpan(plan, entries, plan.sourceEdits?.find((edit) => edit.sourcePath === file.path)?.before ?? content);
    grouped.reason = "Related lines kept together. Choose an allowed category file or save an original idea as a separate note.";
  }

  private applyLineSuggestions(plan: OrganizePlan, lines: PlanAction[], suggestions: AutoOrganizeSuggestion[], sources: Map<string, string>): void {
    const covered = new Set<string>();
    for (const suggestion of [...suggestions].sort((a, b) => a.index - b.index)) {
      const first = lines[suggestion.index];
      if (!first || covered.has(first.id) || first.status !== "pending" || first.destination) continue;
      const end = suggestion.endIndex ?? suggestion.index;
      const entries = lines.slice(suggestion.index, end + 1);
      if (!entries.length || entries.some((entry) => entry.sourcePath !== first.sourcePath || covered.has(entry.id) || entry.destination || entry.status !== "pending")) continue;
      let action = first;
      try { if (entries.length > 1) action = this.mergeEntrySpan(plan, entries, sources.get(first.sourcePath)!); }
      catch { first.reason = "Related lines overlap existing choices. Group them manually before filing."; continue; }
      entries.forEach((entry) => covered.add(entry.id));
      action.reason = suggestion.reason; action.confidence = suggestion.confidence; action.selected = false;
      if (suggestion.kind === "single_line" && suggestion.destinationPath && plan.categories.includes(suggestion.destinationPath) && suggestion.destinationPath !== action.sourcePath) {
        action.entryMode = "append"; action.destination = suggestion.destinationPath;
      } else if (suggestion.kind === "capsule" && suggestion.personalHighValue) {
        this.setEntryMode(plan, action, "capsule");
      } else this.setEntryMode(plan, action, "archive");
    }
  }

  private async showPlan(plan: OrganizePlan, folder?: TFolder, build?: (manual: boolean, status: (text: string) => void, stopped: () => boolean) => Promise<void>, automatic = false): Promise<void> {
    if (this.activePlan) { new Notice("Finish or cancel the current organizer review first."); return; }
    this.activePlan = plan;
    this.applyPolicyToPlan(plan);
    const previousRun = this.settings.history.find((entry) => entry.id === plan.id);
    const createdFolders = new Set<string>(previousRun?.createdFolders || []);
    let reportPath = previousRun?.reportPath || "";
    const persist = async (): Promise<void> => {
      if (!plan.moves.length && !plan.appends.length && !plan.pendingMoves?.length && !plan.createdNotes?.length && !plan.sourceEdits?.length) return;
      let entry = this.settings.history.find((item) => item.id === plan.id);
      if (!entry) {
        entry = { id: plan.id, timestamp: Date.now(), instruction: `Auto organize: ${plan.title}`, moves: plan.moves, appends: plan.appends };
        this.settings.history = [entry, ...this.settings.history].slice(0, HISTORY_LIMIT);
      }
      entry.createdFolders = [...createdFolders];
      entry.reportPath = reportPath;
      entry.pendingMoves = [...(plan.pendingMoves ?? [])];
      entry.createdNotes = plan.createdNotes || [];
      entry.sourceEdits = plan.sourceEdits || [];
      await this.saveSettings();
    };
    const options: ReviewOptions = {
      categoryFolder: this.settings.lineDestinationFolder,
      suggestLines: (status, stopped) => this.suggestPlanLines(plan, status, stopped),
      groupLines: (ids) => this.groupPlanLines(plan, ids),
      changeEntryMode: (action, mode) => this.setEntryMode(plan, action, mode),
      build, automatic, localPreview: plan.title.endsWith(" (duplicates)"),
      release: () => { if (this.activePlan === plan) this.activePlan = null; },
      apply: (ids, stopped, changed) => executePlan(plan, {
        fingerprint: (path) => this.fingerprint(path),
        exists: (path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
        isFolder: (path) => isFilingFolder(path, this.policy) && !isExcludedPath(path, this.settings.excludedFolders) && (!this.app.vault.getAbstractFileByPath(path) || this.app.vault.getAbstractFileByPath(path) instanceof TFolder),
        isNote: (path) => { const file = this.app.vault.getAbstractFileByPath(path); return file instanceof TFile && isAppendNote(path, this.policy) && !isExcludedPath(path, this.settings.excludedFolders); },
        move: async (from, to) => { await this.applyMoves([{ fromPath: from, toPath: to }], createdFolders); },
        appendLine: async (sourcePath, targetPath, text) => {
          const file = this.app.vault.getAbstractFileByPath(targetPath);
          if (!(file instanceof TFile)) throw new Error("Category note is missing.");
          let appended = "";
          await this.app.vault.process(file, (current) => {
            if (entryAlreadyPresent(current, text)) return current;
            appended = `${current.length && !current.endsWith("\n") ? "\n" : ""}${text}\n`;
            return current + appended;
          });
          return appended ? { sourcePath, targetPath, text: appended } : null;
        },
        removeSourceEntry: async (action) => {
          const file = this.app.vault.getAbstractFileByPath(action.sourcePath);
          if (!(file instanceof TFile)) throw new Error("Source is missing.");
          const current = await this.app.vault.read(file);
          if (await digest(current) !== plan.snapshots[action.sourcePath]) throw new Error("Source changed during filing. Filed text is saved; source was kept.");
          const previous = plan.sourceEdits?.find((edit) => edit.sourcePath === action.sourcePath);
          const before = previous?.before ?? current;
          const filed = plan.actions.filter((item) => item.sourcePath === action.sourcePath && item.kind === "line" && (item.status === "done" || item === action));
          const after = withoutFiledEntries(before, filed);
          const edit = previous || { sourcePath: action.sourcePath, before, after: current };
          if (!previous) (plan.sourceEdits ||= []).push(edit);
          const oldAfter = edit.after;
          edit.after = after;
          await persist();
          try {
            await this.app.vault.process(file, (text) => {
              if (text !== current) throw new Error("Source changed during filing. Source was kept.");
              return after;
            });
          } catch (error) { edit.after = oldAfter; throw error; }
        },
        createNote: async (path, text) => {
          const folder = parentFolderPath(path);
          for (const existing of this.app.vault.getMarkdownFiles().filter((file) => parentFolderPath(file.path) === folder)) {
            if ((await this.app.vault.cachedRead(existing)).replace(/\r\n/gu, "\n").trim() === text.replace(/\r\n/gu, "\n").trim()) return existing.path;
          }
          await this.ensureFolder(parentFolderPath(path), createdFolders);
          await this.app.vault.create(path, text);
        },
        save: persist
      }, ids, stopped, changed),
      split: (path) => this.splitPlanFile(plan, path, folder?.path),
      whole: (path) => {
        plan.actions = plan.actions.filter((action) => action.sourcePath !== path);
        delete plan.archives[path];
        this.addFileChoice(plan, path);
      },
      open: (path, line) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void this.app.workspace.getLeaf(true).openFile(file, line ? { eState: { line: line - 1 } } : undefined);
      },
      undo: () => this.undoMove(plan.id, plan),
      trash: async (path) => {
        if (isTrashPath(path) || plan.actions.some((action) => action.sourcePath === path && action.status === "done")) throw new Error("Choose an unprocessed file outside Deleted.");
        if (await this.fingerprint(path) !== plan.snapshots[path]) throw new Error("Source changed since preview. Start a new review before deleting it.");
        const action: PlanAction = { id: crypto.randomUUID(), kind: "trash", sourcePath: path, destination: this.availablePlanPath(plan, trashDestination(plan.id, path)), selected: false, status: "pending", reason: "Move to Deleted at the vault root. Undo restores the original path." };
        const index = plan.actions.findIndex((item) => item.sourcePath === path);
        plan.actions = plan.actions.filter((item) => item.sourcePath !== path);
        plan.actions.splice(index < 0 ? plan.actions.length : index, 0, action);
        delete plan.archives[path];
        await options.apply(new Set([action.id]), () => false, () => {});
        await options.finish();
        if (action.status !== "done") throw new Error(action.outcome || "Could not move the file to Deleted.");
      },
      finish: async () => {
        for (const path of [...createdFolders].sort((a, b) => b.length - a.length)) {
          const folder = this.app.vault.getAbstractFileByPath(path);
          if (path !== TRASH_FOLDER_NAME && !this.policy.filingFolders.includes(path) && folder instanceof TFolder && folder.children.length === 0) {
            await this.app.vault.delete(folder);
            createdFolders.delete(path);
          }
        }
        if (!plan.moves.length && !plan.appends.length && !plan.createdNotes?.length && !plan.sourceEdits?.length) return;
        const deferred = [ ...plan.deferred, ...plan.actions.filter((a) => a.status !== "done").map((a) => ({ path: a.sourcePath, reason: `${a.lineNumber ? `Line ${a.lineNumber}: ` : ""}${a.outcome || (a.selected ? "Still pending." : "Skipped by you.")}` })) ];
        this.settings.lastAutoOrganizeDeferred = deferred;
        this.settings.lastAutoOrganizeSourceFolder = folder?.path || "";
        await this.ensureFolder(LOG_FOLDER_NAME);
        reportPath ||= `${LOG_FOLDER_NAME}/Auto Organize ${plan.id}.md`;
        const text = ["# Auto Organize run", "", `- Time: ${new Date().toISOString()}`, `- Workflow: ${plan.title}`, "", "## Changes",
          ...plan.moves.map((move) => `- ${move.kind === "trash" ? "Deleted to trash" : "Moved"}: ${move.fromPath} -> ${move.toPath}`),
          ...(plan.createdNotes || []).map((note) => `- Created entry: ${note.sourcePath} -> ${note.targetPath}`),
          ...plan.actions.filter((a) => a.kind === "line" && a.status === "done").map((a) => `- ${a.sourcePath}, line ${a.lineNumber} -> ${a.destination}: ${a.outcome}`),
          "", "## Kept for review", ...deferred.map((item) => `- ${item.path}: ${item.reason}`), "", "Use Undo last Auto Organize run to reverse these changes.", ""].join("\n");
        const report = this.app.vault.getAbstractFileByPath(reportPath);
        if (report instanceof TFile) await this.app.vault.modify(report, text);
        else await this.app.vault.create(reportPath, text);
        this.settings.lastAutoOrganizeReportPath = reportPath;
        await persist();
      }
    };
    await this.openReviewSurface(plan, options);
  }

  private async manuallyProcessFiles(files: TFile[], lines = false): Promise<void> {
    if (!this.organizationReady()) return;
    if (this.activePlan) { new Notice("Finish or cancel the current review first."); return; }
    const plan = this.newPlan("Manual organization");
    try {
      for (const file of files) {
        if (isExcludedPath(file.path, this.settings.excludedFolders) || this.isAutoOrganizerInternalPath(file.path)) continue;
        plan.snapshots[file.path] = await this.fingerprint(file.path);
        if (file.extension.toLowerCase() === "md") (plan.previews ||= {})[file.path] = sourcePreview(await this.app.vault.cachedRead(file));
        this.addFileChoice(plan, file.path);
        if (lines) await this.splitPlanFile(plan, file.path);
      }
      if (!plan.actions.length) { new Notice("No eligible files were selected."); return; }
      await this.showPlan(plan);
    } catch (error) { new Notice(error instanceof Error ? error.message : "Could not read selected files."); }
  }

  private async autoOrganizeFolder(folder: TFolder, mode: "full" | "duplicates" | "nonduplicates", forcePreview = false): Promise<void> {
    if (!this.organizationReady()) return;
    if (this.activePlan) { new Notice("Finish or cancel the current review first."); return; }
    if (isExcludedPath(folder.path, this.settings.excludedFolders) || this.isAutoOrganizerInternalPath(folder.path) || this.isLineDestinationPath(folder.path)) {
      new Notice("This folder is excluded from Auto Organize."); return;
    }
    const plan = this.newPlan(`${folder.path || "Vault root"} (${mode})`);
    await this.showPlan(plan, folder, async (manual, status, stopped) => {
      // Snapshot before AI. Execution refuses files edited while the preview is open.
      const candidates = this.collectMarkdownFiles(folder);
      const contents = new Map<string, string>();
      const duplicatePaths = new Set<string>();
      if (mode === "nonduplicates") {
        status("Checking for exact duplicates locally...");
        const firstByContent = new Map<string, string>();
        for (const file of candidates) {
          if (stopped()) return;
          const content = await this.app.vault.read(file);
          contents.set(file.path, content);
          const normalized = content.replace(/\r\n/gu, "\n").trim();
          if (!normalized) continue;
          const key = await digest(normalized);
          const first = firstByContent.get(key);
          if (first) {
            duplicatePaths.add(first);
            duplicatePaths.add(file.path);
          } else firstByContent.set(key, file.path);
        }
        plan.actions = plan.actions.filter((action) => action.status !== "pending" || !duplicatePaths.has(action.sourcePath));
      }
      const files = candidates.filter((file) => !duplicatePaths.has(file.path) && !plan.actions.some((action) =>
        action.sourcePath === file.path && (action.status === "done" || Boolean(action.destination) || action.kind === "line")));
      for (const file of files) {
        if (stopped()) return;
        const content = contents.get(file.path) ?? await this.app.vault.read(file);
        contents.set(file.path, content);
        const fingerprint = await digest(content);
        if (plan.snapshots[file.path] && plan.snapshots[file.path] !== fingerprint) throw new Error("Source changed since review. Start a new review.");
        plan.snapshots[file.path] = fingerprint;
        (plan.previews ||= {})[file.path] = sourcePreview(content);
        if (!plan.actions.some((action) => action.sourcePath === file.path)) this.addFileChoice(plan, file.path);
      }
      const visit = async (current: TFolder): Promise<void> => {
        for (const child of current.children) {
          if (stopped()) return;
          if (isExcludedPath(child.path, this.settings.excludedFolders) || this.isAutoOrganizerInternalPath(child.path) || this.isLineDestinationPath(child.path)) continue;
          if (child instanceof TFolder) await visit(child);
          else if (child instanceof TFile && child.extension.toLowerCase() !== "md") {
            if (plan.actions.some((action) => action.sourcePath === child.path)) continue;
            plan.snapshots[child.path] = await this.fingerprint(child.path);
            this.addFileChoice(plan, child.path, "AI does not classify this file type. Choose a folder manually.");
          }
        }
      };
      await visit(folder);
      if (manual || stopped() || !files.length) return;
      const excerpts = files.map((file) => ({ file, excerpt: firstWords(contents.get(file.path)!) }));
      if (mode !== "nonduplicates") {
        status("Checking full-content duplicates locally...");
        const keepers = new Map<string, string>();
        for (const file of files) {
          if (stopped()) return;
          const content = contents.get(file.path)!.replace(/\r\n/gu, "\n").trim();
          if (!content) continue;
          const key = await digest(content);
          const keeper = keepers.get(key);
          if (!keeper) { keepers.set(key, file.path); continue; }
          const action = plan.actions.find((item) => item.sourcePath === file.path)!;
          action.kind = "duplicate"; action.duplicateVerified = true;
          action.destination = this.availablePlanPath(plan, trashDestination(plan.id, file.path));
          action.keeperPath = keeper; action.confidence = 1; action.selected = false;
          action.reason = `Full-content duplicate. Keep ${keeper}; delete this extra copy to Deleted.`;
        }
      }
      if (mode === "duplicates" || stopped()) return;
      const remaining = excerpts.filter(({ file }) => plan.actions.find((a) => a.sourcePath === file.path)?.kind !== "duplicate");
      if (!remaining.length) return;
      const { apiKey, provider, model } = await getAiConnection(this.app, this.settings, this.manifest.dir);
      if (stopped()) return;
      let charged = false;
      const call = async <T>(action: () => Promise<T>): Promise<T> => {
        if (stopped()) throw new Error("Planning stopped. Nothing has been applied.");
        const result = charged ? await action() : await this.runMeteredAi(files[0], "Auto Organize preview", action);
        charged = true; return result;
      };
      const folderPaths = plan.folders.filter((path) => path !== folder.path && !(path === "/" && !folder.path) && (!folder.path || !path.startsWith(`${folder.path}/`)) && !isExcludedPath(path, this.settings.excludedFolders));
      const destinationContext = this.planDestinationContext(plan, folderPaths);
      const lineDestinationContext = this.planDestinationContext(plan);
      status(`Planning destinations for ${remaining.length} notes...`);
      const suggestions = await call(() => classifyAutoOrganizeItems(apiKey, model,
        remaining.map(({ file }, index) => ({ index, path: file.path, excerpt: sourceFileExcerpt(contents.get(file.path)!), nonEmptyLines: contents.get(file.path)!.split(/\r?\n/u).filter((line) => line.trim()).length })),
        folderPaths, plan.categories, stopped, provider, destinationContext, false, this.policy));
      if (stopped()) return;
      const byIndex = new Map(suggestions.map((item) => [item.index, item]));
      for (const [index, { file }] of remaining.entries()) {
        if (stopped()) return;
        const suggestion = byIndex.get(index);
        const action = plan.actions.find((a) => a.sourcePath === file.path)!;
        action.reason = suggestion?.reason || "No suggestion. Choose a destination manually.";
        action.confidence = suggestion?.confidence;
        if (!suggestion) continue;
        if (suggestion.kind === "mixed" || suggestion.kind === "archive") { action.destination = this.policy.archiveFolder; continue; }
        if (suggestion.kind === "capsule") { action.destination = suggestion.personalHighValue ? this.policy.capsuleFolder : this.policy.archiveFolder; continue; }
        if (suggestion.kind === "full_file") {
          action.destination = suggestion.destinationPath && folderPaths.includes(suggestion.destinationPath) && ![this.policy.capsuleFolder, this.policy.archiveFolder].includes(suggestion.destinationPath) ? suggestion.destinationPath : "";
          action.selected = false;
          continue;
        }
        if (suggestion.kind === "single_line") {
          action.kind = "line"; action.entryMode = "append"; action.lineNumber = 1;
          action.lineEndNumber = contents.get(file.path)!.split(/\r?\n/u).length;
          action.text = contents.get(file.path)!;
          action.destination = suggestion.destinationPath && plan.categories.includes(suggestion.destinationPath) ? suggestion.destinationPath : "";
          if (!action.destination) this.setEntryMode(plan, action, "archive");
          plan.archives[file.path] = this.availablePlanPath(plan, trashDestination(plan.id, file.path));
          continue;
        }
        const captures = captureLines(contents.get(file.path)!);
        if (!captures.lines.length) {
          action.reason = "No plain capture entries. Archive for review rather than splitting structured content.";
          action.destination = this.policy.archiveFolder;
          continue;
        }
        await this.splitPlanFile(plan, file.path, folder.path);
        const lines = plan.actions.filter((a) => a.sourcePath === file.path);
        const lineSuggestions = await call(() => classifyAutoOrganizeItems(apiKey, model,
          lines.map((line, index) => ({ index, path: file.path, lineNumber: line.lineNumber, excerpt: firstWords(line.text!), sourceContext: sourceLineContext(contents.get(file.path)!, line.lineNumber!), nonEmptyLines: 1 })), plan.folders.filter((path) => [this.policy.capsuleFolder, this.policy.archiveFolder].includes(path)), plan.categories, stopped, provider, lineDestinationContext, true, this.policy));
        if (stopped()) return;
        this.applyLineSuggestions(plan, lines, lineSuggestions, contents);
      }
    }, !forcePreview && this.settings.organizeWorkflow === "automatic");
  }

  private async findDuplicatesInFolder(folder: TFolder): Promise<void> {
    if (isExcludedPath(folder.path, this.settings.excludedFolders)) {
      new Notice("This folder is excluded from duplicate scans.");
      return;
    }
    const adapter = this.app.vault.adapter;
    if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) {
      new Notice("Folder duplicate scanning currently needs Obsidian Desktop for bounded file reads.");
      return;
    }
    const connection = await getAiConnection(this.app, this.settings, this.manifest.dir).catch((error) => {
      new Notice(error instanceof Error ? error.message : "AI connection is unavailable."); return null;
    });
    if (!connection) return;
    const { apiKey, provider } = connection;

    const notes: TFile[] = [];
    const visit = (current: TFolder): void => {
      for (const child of current.children) {
        if (isExcludedPath(child.path, this.settings.excludedFolders)) continue;
        if (child instanceof TFolder) visit(child);
        else if (child instanceof TFile && child.extension.toLocaleLowerCase() === "md") notes.push(child);
      }
    };
    visit(folder);
    notes.sort((a, b) => a.path.localeCompare(b.path));
    if (notes.length < 2) {
      new Notice("Choose a folder with at least two Markdown notes.");
      return;
    }

    const status = new Notice(`Checking the first 200 words of ${notes.length} Markdown notes locally for likely matches...`, 0);
    try {
      const noteExcerpts = await Promise.all(notes.map(async (file) => ({
        file,
        excerpt: await readFirstWordsFromDisk(adapter.getFullPath(file.path))
      })));
      const usableNotes = noteExcerpts.filter((item) => item.excerpt.trim().length > 0);
      if (usableNotes.length < 2) {
        status.hide();
        new Notice("At least two non-empty Markdown notes are needed for duplicate matching.");
        return;
      }
      const excerpts = usableNotes.map((item) => item.excerpt);
      const candidates = findLikelyDuplicatePairs(excerpts);
      if (!candidates.length) {
        status.hide();
        new Notice("No likely duplicate pairs were found in the first 200 words. Nothing was sent to the AI provider.");
        return;
      }

      const candidateIndices = [...new Set(candidates.flatMap((pair) => [pair.firstIndex, pair.secondIndex]))].sort((a, b) => a - b);
      const localIndex = new Map(candidateIndices.map((index, position) => [index, position]));
      const candidateNotes = candidateIndices.map((index) => usableNotes[index]);
      const candidateExcerpts = candidateIndices.map((index) => excerpts[index]);
      const candidatePairs = candidates.map((pair) => ({
        firstIndex: localIndex.get(pair.firstIndex)!,
        secondIndex: localIndex.get(pair.secondIndex)!
      }));
      status.setMessage(`Sending first-200-word excerpts for ${candidateNotes.length} likely matching notes to ${providerName(provider)}...`);
      const pairs = await this.runMeteredAi(candidateNotes[0].file, "Find duplicates", () =>
        findDuplicatePairs(apiKey, candidateExcerpts, candidatePairs, undefined, undefined, provider));
      status.hide();
      void matomoFor(this)?.event("feature", "completed", "duplicate_detection", candidateNotes.length);
      new DuplicateResultsModal(this.app, folder.path || "Vault root", notes.length, candidateNotes.map(({ file }) => ({ path: file.path })), pairs).open();
    } catch (error) {
      status.hide();
      const message = error instanceof Error ? error.message : "Unknown error";
      new Notice(`Duplicate scan failed: ${message}`);
    }
  }

  private openInstructionModal(files: TFile[], initialValue = ""): void {
    new InstructionModal(this.app, initialValue, (instruction) => {
      void this.organizeFiles(files, instruction);
    }).open();
  }

  private async openFolderPicker(files: TFile[]): Promise<void> {
    await this.manuallyProcessFiles(files);
  }

  private async organizeFiles(files: TFile[], instruction: string): Promise<void> {
    if (!this.organizationReady()) return;
    if (this.activePlan) { new Notice("Finish or cancel the current review first."); return; }
    const primary = files[0];
    if (!primary) return;
    const folders = listFolders(this.app.vault.getRoot()).filter((folder) => isFilingFolder(folder.path, this.policy) && !isExcludedPath(folder.path, this.settings.excludedFolders));
    const explicitPhrase = extractDestinationPhrase(instruction);
    const includeAttachments = commandIncludesAttachments(instruction);
    const rules = await this.loadRules();
    if (explicitPhrase) {
      const matches = this.policy.filingFolders.filter((path) => !isExcludedPath(path, this.settings.excludedFolders)
        && (normalizePath(path) === normalizePath(explicitPhrase)
          || rules.some((rule) => normalizePath(rule.phrase) === normalizePath(explicitPhrase) && rule.destination === path)));
      if (matches.length === 1) {
        await this.moveFiles(files, { path: matches[0] }, instruction, includeAttachments);
        return;
      }
    }

    if (explicitPhrase) {
      const allMatches = matchFolderPhrase(explicitPhrase, listFolders(this.app.vault.getRoot()), true, this.settings.excludedFolders);
      if (allMatches.length && allMatches.every((folder) => !isFilingFolder(folder.path, this.policy))) {
        new Notice("That destination is outside your saved organization rules."); return;
      }
      const directMatches = matchFolderPhrase(explicitPhrase, folders, false, this.settings.excludedFolders);
      if (directMatches.length === 1) {
        await this.moveFiles(files, directMatches[0], instruction, includeAttachments);
        return;
      }
      if (directMatches.length > 1) {
        this.openChoicePicker(files, directMatches, instruction, includeAttachments);
        return;
      }

      const ruleMatches = resolveRule(explicitPhrase, rules, folders, this.settings.excludedFolders);
      if (ruleMatches.length === 1) {
        await this.moveFiles(files, ruleMatches[0], instruction, includeAttachments);
        return;
      }
      if (ruleMatches.length > 1) {
        this.openChoicePicker(files, ruleMatches, instruction, includeAttachments);
        return;
      }
    }

    const learned = this.settings.learnFromMoves
      ? resolveLearnedMove(parentFolderPath(primary.path), primary.basename, this.settings.learnedMoves, folders, this.settings.excludedFolders)
      : undefined;
    if (learned && files.length === 1) {
      await this.moveFiles(files, learned, instruction, includeAttachments);
      return;
    }

    const eligibleFolders = folders.filter((folder) => !isExcludedPath(folder.path, this.settings.excludedFolders));
    if (isExcludedPath(primary.path, this.settings.excludedFolders)) {
      this.openChoicePicker(files, eligibleFolders, "Choose a destination for this excluded file", false);
      return;
    }

    const connection = await getAiConnection(this.app, this.settings, this.manifest.dir).catch((error) => {
      new Notice(error instanceof Error ? error.message : "AI connection is unavailable."); return null;
    });
    if (!connection) {
      this.openChoicePicker(files, eligibleFolders, instruction, includeAttachments);
      return;
    }
    void matomoFor(this)?.event("feature", "started", "note_routing");

    try {
      const noteExcerpt = this.settings.sendNoteContent && primary.extension.toLocaleLowerCase() === "md"
        ? sourceFileExcerpt(await this.app.vault.cachedRead(primary))
        : undefined;
      const examples = this.settings.learnFromMoves
        ? this.settings.learnedMoves.slice(0, EXAMPLE_LIMIT).map((item) => ({
          fileName: item.exampleName,
          sourceFolder: item.sourceFolder,
          destinationFolder: item.destinationFolder,
          count: item.count
        }))
        : [];
      const popularDestinations = this.settings.learnFromMoves
        ? rankPopularDestinations(
          this.settings.history,
          this.settings.learnedMoves,
          eligibleFolders.map((folder) => folder.path)
        )
        : [];
      const destinationSamples = this.settings.sendNoteContent
        ? await this.planDestinationContext(this.newPlan(instruction), eligibleFolders.map((folder) => folder.path))([{ path: primary.path, excerpt: noteExcerpt || primary.basename }], () => false)
        : [];
      const suggestion = await this.runMeteredAi(primary, "AI routing", () => suggestDestination({
        policy: this.policy,
        apiKey: connection.apiKey,
        provider: connection.provider,
        model: connection.model,
        instruction,
        sourcePath: primary.path,
        fileName: primary.basename,
        folderPaths: eligibleFolders.map((folder) => folder.path),
        popularDestinations,
        learnedExamples: examples,
        noteExcerpt, destinationSamples
      }));
      const destination = suggestion.destination
        ? findFolderByPath(suggestion.destination, eligibleFolders)
        : undefined;
      if (destination && suggestion.confidence >= AUTO_ROUTE_CONFIDENCE) {
        await this.moveFiles(files, destination, instruction, includeAttachments);
        void matomoFor(this)?.event("feature", "completed", "note_routing");
        return;
      }
      this.openChoicePicker(files, eligibleFolders, instruction, includeAttachments);
    } catch {
      void matomoFor(this)?.event("feature", "failed", "note_routing");
      new Notice("The AI provider could not suggest a folder. Choose one directly or try again.");
      this.openChoicePicker(files, eligibleFolders, instruction, includeAttachments);
    }
  }

  private openChoicePicker(files: TFile[], folders: TFolder[], title: string, includeAttachments = false): void {
    if (!folders.length) {
      new Notice("No destination folders are available.");
      return;
    }
    new FolderPickerModal(this.app, folders, title, (folder) => {
      void this.moveFiles(files, folder, title, includeAttachments);
    }).open();
  }

  private async moveFiles(files: TFile[], destination: Pick<TFolder, "path">, instruction: string, includeAttachments: boolean): Promise<void> {
    if (!this.organizationReady()) return;
    if (!isFilingFolder(destination.path, this.policy) || isExcludedPath(destination.path, this.settings.excludedFolders)) { new Notice("Choose a folder allowed by your saved organization rules."); return; }
    const uniqueFiles = [...new Map(files.map((file) => [file.path, file])).values()];
    const sources: TFile[] = [...uniqueFiles];
    if (includeAttachments) {
      for (const file of uniqueFiles) {
        if (file.extension.toLocaleLowerCase() !== "md") continue;
        const embeds = this.app.metadataCache.getFileCache(file)?.embeds ?? [];
        for (const embed of embeds) {
          const linked = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
          if (linked instanceof TFile && linked.extension.toLocaleLowerCase() !== "md") sources.push(linked);
        }
      }
    }
    const deduplicated = [...new Map(sources.map((file) => [file.path, file])).values()];
    const operations: Array<{ file: TFile; fromPath: string; toPath: string }> = [];
    for (const file of deduplicated) {
      const toPath = destination.path ? `${destination.path}/${file.name}` : file.name;
      if (normalizePath(file.path) === normalizePath(toPath)) continue;
      operations.push({ file, fromPath: file.path, toPath });
    }
    if (!operations.length) {
      new Notice("The selected files are already in that folder.");
      return;
    }

    if (this.activePlan) { new Notice("Finish or cancel the current review first."); return; }
    const plan = this.newPlan(instruction);
    if (!plan.folders.includes(destination.path)) plan.folders.push(destination.path);
    try {
      for (const operation of operations) {
        plan.snapshots[operation.fromPath] = await this.fingerprint(operation.fromPath);
        this.addFileChoice(plan, operation.fromPath, instruction, destination.path, true);
      }
      await this.showPlan(plan);
    } catch { new Notice("Could not read selected files. Nothing was moved."); }
  }

  private handleVaultRename(file: TAbstractFile, oldPath: string): void {
    if (this.programmaticMovePaths.has(oldPath)) {
      this.programmaticMovePaths.delete(oldPath);
      return;
    }
    if (!this.settings.learnFromMoves || !(file instanceof TFile) || file.extension.toLocaleLowerCase() !== "md") return;
    if (isExcludedPath(oldPath, this.settings.excludedFolders) || isExcludedPath(file.path, this.settings.excludedFolders)) return;

    const sourceFolder = parentFolderPath(oldPath);
    const destinationFolder = parentFolderPath(file.path);
    if (normalizePath(sourceFolder) === normalizePath(destinationFolder)) return;

    const existing = this.settings.learnedMoves.find((item) =>
      normalizePath(item.sourceFolder) === normalizePath(sourceFolder) &&
      normalizePath(item.destinationFolder) === normalizePath(destinationFolder) &&
      normalizePath(item.exampleName) === normalizePath(file.basename)
    );
    if (existing) {
      existing.count += 1;
      existing.updatedAt = Date.now();
    } else {
      const learned: LearnedMove = {
        sourceFolder,
        destinationFolder,
        exampleName: file.basename,
        count: 1,
        updatedAt: Date.now()
      };
      this.settings.learnedMoves = [learned, ...this.settings.learnedMoves].slice(0, 100);
    }
    void this.saveSettings();
  }
}
