import { App, Modal, Notice, Plugin, Setting } from "obsidian";
import manifest from "../manifest.json";
import { diagnostics } from "./diagnostics";
import { DiagnosticLog } from "./diagnostic-log";

interface SupportHost extends Plugin {
  settings?: { debugLogging?: boolean };
  saveSettings?: () => Promise<void>;
}

class HelpModal extends Modal {
  constructor(app: App, private readonly plugin: Plugin) { super(app); }
  onOpen(): void {
    this.titleEl.setText("Hudson Auto Organizer AI Help");
    this.contentEl.createEl("p", { text: "Choose the PARA default or enter your own organization rules in Hudson settings. Each vault keeps its own rules. Review destinations before applying." });
    const steps = this.contentEl.createEl("ol");
    ["Use the command palette or a folder context menu to start Auto Organize.", "Hudson checks full-content duplicates locally, then classifies remaining notes using bounded source and destination samples.", "Review files and entries. Group selected related lines when needed. Use your saved category, original-idea and review destinations. Nothing is selected by default. Apply one item or selected choices. Stop keeps completed work. Delete, exact duplicate extras and fully processed originals move to Deleted, with Undo and a run log."]
      .forEach((text) => steps.createEl("li", { text }));
    this.contentEl.createEl("p", { text: "AI receives full source and destination paths, short source samples and samples from up to 12 relevant destination files per batch. Each destination sample is capped at 45 words and 320 characters. File samples cover the start, middle and end; line suggestions include short neighboring context. Full destination files are never sent. Instructions inside note text cannot authorize actions. In Lines, Suggest line destinations uses one AI run to fill unresolved choices without applying them." });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Open plugin settings").onClick(() => {
      const setting = (this.app as App & { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
      this.close();
    }));
  }
  onClose(): void { this.contentEl.empty(); }
}

export class PluginSupport {
  private readonly log: DiagnosticLog;
  private started = false;
  private lastFailureNotice = 0;

  constructor(private readonly plugin: SupportHost) {
    const configDir = plugin.app.vault.configDir;
    const directory = plugin.manifest.dir || `${configDir}/plugins/${plugin.manifest.id}`;
    this.log = new DiagnosticLog(plugin.manifest.id, plugin.manifest.version, `${directory}/diagnostic-log.json`, plugin.app.vault.adapter);
    diagnostics.attach(this, () => this.plugin.settings?.debugLogging === true);
    this.plugin.register(() => { this.info("plugin.unloaded"); diagnostics.detach(this); void this.log.close(); });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.info("plugin.loaded", { version: this.plugin.manifest.version });
    this.plugin.registerDomEvent(window, "error", (event: ErrorEvent) => {
      const source = event.filename || event.error?.stack || "";
      if (!source || source.includes("plugin:" + this.plugin.manifest.id)) this.error("runtime.error", event.error);
    });
    this.plugin.registerDomEvent(window, "unhandledrejection", (event: PromiseRejectionEvent) => {
      const source = event.reason?.stack || "";
      if (!source || source.includes("plugin:" + this.plugin.manifest.id)) diagnostics.failure("runtime.unhandled_rejection", event.reason);
    });
    this.plugin.addCommand({ id: "open-help", name: "Open Hudson Help", callback: () => new HelpModal(this.plugin.app, this.plugin).open() });
    this.plugin.addCommand({ id: "copy-diagnostic-log", name: "Copy diagnostic log", callback: () => void this.copyDiagnosticLog() });
    this.plugin.addCommand({ id: "view-diagnostic-log", name: "View diagnostic log", callback: () => void this.viewDiagnosticLog() });
    this.plugin.addCommand({ id: "toggle-debug-logging", name: "Toggle debug logging", callback: () => void this.setDebugLogging(!this.plugin.settings?.debugLogging) });
  }

  info(event: string, detail?: unknown): void { this.record("info", event, detail); }
  warn(event: string, detail?: unknown): void { this.record("warn", event, detail); }
  error(event: string, detail?: unknown): void { this.record("error", event, detail); }

  addHelpSettings(container: HTMLElement): void {
    new Setting(container).setName("Help").setDesc("How to organize notes, understand AI data use, and recover from a run.")
      .addButton((button) => button.setButtonText("Open Help").onClick(() => new HelpModal(this.plugin.app, this.plugin).open()));
    new Setting(container).setName("Debug logging").setDesc("Record extra event timing for troubleshooting. Off by default; note content and file paths are excluded.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings?.debugLogging === true).onChange((value) => void this.setDebugLogging(value)));
    new Setting(container).setName("Diagnostics").setDesc("The local log survives restarts, with up to 1,000 events and a 256 KB limit. It excludes note content, paths, raw errors, keys and account details.")
      .addButton((button) => button.setButtonText("View log").onClick(() => void this.viewDiagnosticLog()))
      .addButton((button) => button.setButtonText("Copy diagnostic log").onClick(() => void this.copyDiagnosticLog()));
  }

  private record(level: "info" | "warn" | "error", event: string, detail?: unknown): void {
    this.log.record(level, event, detail);
  }

  notifyFailure(_stage: string): void {
    const now = Date.now();
    if (now - this.lastFailureNotice < 5000) return;
    this.lastFailureNotice = now;
    new Notice("Hudson Auto Organizer AI could not finish that action. Try again or copy the diagnostic log for support.");
  }

  private async setDebugLogging(enabled: boolean): Promise<void> {
    const settings = this.plugin.settings;
    if (!settings) return;
    const old = settings.debugLogging;
    settings.debugLogging = enabled;
    try { await (this.plugin.saveSettings?.() ?? this.plugin.saveData(settings)); }
    catch (error) { settings.debugLogging = old; diagnostics.failure("settings.debug_logging.save", error); new Notice("Could not save the logging preference."); }
  }

  private async copyDiagnosticLog(): Promise<void> {
    try { await this.log.flush(); await navigator.clipboard.writeText(await this.log.export()); new Notice("Diagnostic log copied. Review it before sharing."); }
    catch (error) { diagnostics.failure("support.copy_diagnostic_log", error); new Notice("Could not copy the diagnostic log. Check clipboard access and try again."); }
  }

  private async viewDiagnosticLog(): Promise<void> {
    await this.log.flush();
    const data = await this.log.export();
    const modal = new Modal(this.plugin.app);
    modal.titleEl.setText("Hudson diagnostic log");
    modal.contentEl.createEl("p", { text: "Basic events are recorded automatically. Debug logging adds detailed stage timings. This log stays local and may follow your vault sync settings." });
    modal.contentEl.createEl("pre", { text: data });
    modal.contentEl.createEl("small", { text: `Hudson Auto Organizer AI ${manifest.version}` });
    modal.open();
  }
}
