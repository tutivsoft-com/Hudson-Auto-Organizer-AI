import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { DEFAULT_POLICY } from "./organization-policy";
import { OPENAI_MODEL, OPENAI_SECRET_ID } from "./ai-provider";
import manifest from "../manifest.json";
import AutoOrganizerPlugin from "./main";
import { addBillingAccountSettings } from "./constance-account";
import { AUTO_ORGANIZER_APP_ID } from "./constance-v2";
import { addLivePacks } from "./billing-catalog";

interface SecretComponentLike {
  setValue(value: string): SecretComponentLike;
  onChange(callback: (value: string) => void): SecretComponentLike;
}

type SecretComponentConstructor = new (app: App, containerEl: HTMLElement) => SecretComponentLike;

export class AutoOrganizerSettingTab extends PluginSettingTab {
  plugin: AutoOrganizerPlugin;

  constructor(app: App, plugin: AutoOrganizerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Hudson Auto Organizer AI" });
    containerEl.createEl("p", { text: "Use folder actions to sort notes, file capture lines, and find duplicates. Mixed or uncertain items stay for your review." });

    const organization = containerEl.createDiv({ cls: "oao-organization-settings" });
    organization.createEl("h3", { text: "Organization rules" });
    organization.createEl("p", { text: this.plugin.settings.organizationNeedsSetup
      ? "Choose the default or save your own rules before organizing. Your notes and previous Undo history have been kept."
      : this.plugin.settings.organizationMode === "custom" ? "Using your saved rules in this vault." : "Using the PARA default in this vault." });
    new Setting(organization).setName("Default organization")
      .setDesc("PARA groups notes into Projects, Areas, Resources and Archives. Original ideas use Resources/Ideas. Unclear items wait in Inbox/Review. Choosing this does not move notes or create folders.")
      .addButton((button) => button.setButtonText("Use default").onClick(async () => {
        try { await this.plugin.useDefaultOrganization(); this.display(); }
        catch (error) { new Notice(error instanceof Error ? error.message : "Could not save the default."); }
      }));
    new Setting(organization).setName("My organization rules")
      .setDesc("Describe where whole notes, captures, ideas and unclear items belong. Mention folders to keep reference-only and any special cases. Use paths relative to this vault. Rules are saved only for this vault. Editing the draft does not replace your active rules.")
      .addTextArea((text) => {
        text.setPlaceholder("Keep client work in Work/Clients, learning in Learning, and personal notes in Home. Append captures to existing notes in those folders. Put original ideas in Learning/Ideas and unclear items in Inbox/Review. Keep Old Records reference-only.");
        text.setValue(this.plugin.settings.organizationInstructions);
        text.inputEl.rows = 12;
        text.inputEl.addClass("oao-rules-input");
        text.inputEl.maxLength = 20000;
        text.onChange((value) => { this.plugin.settings.organizationInstructions = value; void this.plugin.saveSettings(); });
      });
    const saveStatus = organization.createEl("p", { cls: "setting-item-description", attr: { role: "status", "aria-live": "polite" } });
    const draftChanged = this.plugin.settings.organizationMode === "custom" && this.plugin.settings.organizationPolicy?.instructions !== this.plugin.settings.organizationInstructions.trim();
    saveStatus.setText(draftChanged ? "Draft changes are not active yet. Use Save my rules to apply them to future reviews." : "Saving rules never files or changes notes.");
    new Setting(organization).setName("Save my rules")
      .setDesc("AI reads your draft and folder names to build your destination list. No note text is sent for setup. This uses your selected AI connection and no organize-run credit. Check the saved destinations below; edit and save again if needed.")
      .addButton((button) => button.setButtonText("Save my rules").onClick(async () => {
        button.setDisabled(true); saveStatus.setText("Reading your organization rules...");
        try { await this.plugin.saveOrganizationRules(); this.display(); }
        catch (error) { saveStatus.setText(error instanceof Error ? error.message : "Could not save these rules. Your previous rules are still active."); }
        finally { button.setDisabled(false); }
      }));
    if (!this.plugin.settings.organizationNeedsSetup) {
      const policy = this.plugin.settings.organizationMode === "custom" ? this.plugin.settings.organizationPolicy! : DEFAULT_POLICY;
      const summary = organization.createEl("details", { cls: "oao-policy-summary" });
      summary.createEl("summary", { text: "Active destinations and exceptions" });
      summary.createEl("p", { text: `Whole notes: ${policy.filingFolders.join("; ")}` });
      summary.createEl("p", { text: `Append to existing notes under: ${policy.appendRoots.join("; ")}` });
      summary.createEl("p", { text: `Original ideas: ${policy.capsuleFolder}. Unclear items: ${policy.archiveFolder}. Reference fallback: ${policy.defaultFolder}.` });
      summary.createEl("p", { text: `Reference-only for appends: ${policy.referencePaths.join("; ") || "None"}` });
      summary.createEl("p", { text: `Aliases: ${policy.aliases.map((alias) => `${alias.phrase}: ${alias.destination}`).join("; ") || "None"}` });
    }

    new Setting(containerEl)
      .setName("Settings view")
      .setDesc("Keep everyday setup visible, or show the optional controls too.")
      .addDropdown((dropdown) => dropdown
        .addOption("simple", "Simple")
        .addOption("advanced", "Advanced")
        .setValue(this.plugin.settings.settingsMode)
        .onChange(async (value) => {
          this.plugin.settings.settingsMode = value === "advanced" ? "advanced" : "simple";
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName("Folder workflow")
      .setDesc("Preview builds a dry run with file and line choices. Automatic applies confident suggestions, keeps uncertain items for review, and offers Stop and Undo. AI planning uses one run credit, even if the preview is canceled.")
      .addDropdown((dropdown) => dropdown.addOption("preview", "Preview changes first").addOption("automatic", "Run automatically")
        .setValue(this.plugin.settings.organizeWorkflow).onChange(async (value) => {
          this.plugin.settings.organizeWorkflow = value === "automatic" ? "automatic" : "preview";
          await this.plugin.saveSettings();
        }));

    const advanced = containerEl.createDiv({ cls: "oao-advanced-settings" });
    advanced.hidden = this.plugin.settings.settingsMode !== "advanced";

    new Setting(containerEl).setName("AI provider")
      .setDesc("New installs use OpenRouter. Choose OpenAI to use your own key. Failed requests stay with the selected provider.")
      .addDropdown((dropdown) => dropdown.addOption("openai", "OpenAI").addOption("openrouter", "OpenRouter")
        .setValue(this.plugin.settings.aiProvider).onChange(async (value) => {
          this.plugin.settings.aiProvider = value === "openrouter" ? "openrouter" : "openai";
          await this.plugin.saveSettings(); this.display();
        }));
    if (this.plugin.settings.aiProvider === "openai") {
      const keySetting = new Setting(containerEl).setName("OpenAI key")
        .setDesc("Hudson reads your key from Obsidian Secret Storage. Your OpenAI account controls OpenAI charges.");
      new SecretComponent(this.app, keySetting.controlEl).setValue(OPENAI_SECRET_ID).onChange((id) => {
        if (id && id !== OPENAI_SECRET_ID) {
          const key = this.app.secretStorage.getSecret(id);
          if (key) this.app.secretStorage.setSecret(OPENAI_SECRET_ID, key);
        }
      });
      new Setting(advanced).setName("OpenAI model").setDesc("Model for file routing and capture classification. Duplicate checks use text-embedding-3-small.")
        .addText((text) => text.setPlaceholder(OPENAI_MODEL).setValue(this.plugin.settings.openaiModel)
          .onChange((value) => { this.plugin.settings.openaiModel = value.trim() || OPENAI_MODEL; void this.plugin.saveSettings(); }));
    } else {
      new Setting(containerEl).setName("AI service").setDesc("The managed OpenRouter key has a USD $1 lifetime limit.");
    }

    new Setting(advanced)
      .setName("OpenRouter model")
      .setDesc("Model for routing and classification using full allowed paths, bounded source samples and short examples from relevant destination files. Organization rules constrain every result.")
      .addText((text) => text
        .setPlaceholder("~deepseek/deepseek-v4-flash-latest")
        .setValue(this.plugin.settings.model)
        .onChange((value) => {
          this.plugin.settings.model = value.trim() || "~deepseek/deepseek-v4-flash-latest";
          void this.plugin.saveSettings();
        }));

    new Setting(advanced)
      .setName("Markdown rules file")
      .setDesc("Optional shortcuts such as Reference => Resources. Destinations must also be allowed by your saved organization rules.")
      .addText((text) => text
        .setValue(this.plugin.settings.rulesFilePath)
        .onChange((value) => {
          this.plugin.settings.rulesFilePath = value.trim() || "Auto Organizer Rules.md";
          void this.plugin.saveSettings();
        }))
      .addButton((button) => button
        .setButtonText("Open or create")
        .onClick(() => void this.plugin.openRulesFile()));

    new Setting(advanced)
      .setName("Excluded folders")
      .setDesc("Only paths you list here are excluded. Folder names such as PASSWORDS, private, archive and templates are allowed by default.")
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.excludedFolders);
        text.inputEl.rows = 4;
        text.inputEl.addClass("oao-exclusions-input");
        text.onChange((value) => {
          this.plugin.settings.excludedFolders = value;
          void this.plugin.saveSettings();
        });
      });

    new Setting(advanced)
      .setName("Learn from my file moves")
      .setDesc("When enabled, remember local folder examples from manual moves and share recent destination counts with vague AI requests. Only folder paths and counts are sent for popularity context. Examples stay in this vault's plugin settings and can be removed below.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.learnFromMoves)
        .onChange((value) => {
          this.plugin.settings.learnFromMoves = value;
          void this.plugin.saveSettings();
        }));

    new Setting(advanced)
      .setName("Send note text for AI routing")
      .setDesc("Off by default. AI requests always include your instruction, file name, current path, folder paths, and approved move examples. When enabled, routing can also send excerpts from the selected note and possible destination notes.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.sendNoteContent)
        .onChange((value) => {
          this.plugin.settings.sendNoteContent = value;
          void this.plugin.saveSettings();
        }));

    const learned = this.plugin.settings.learnedMoves ?? [];
    advanced.createEl("h3", { text: `Learned routes (${learned.length})` });
    if (!learned.length) {
      advanced.createEl("p", { text: "No moves have been recorded." });
    } else {
      for (const [index, route] of learned.entries()) {
        new Setting(advanced)
          .setName(route.exampleName || "Moved file")
          .setDesc(`${route.sourceFolder || "Vault root"} → ${route.destinationFolder} · ${route.count} move${route.count === 1 ? "" : "s"}`)
          .addButton((button) => button
            .setButtonText("Forget")
            .onClick(() => {
              this.plugin.settings.learnedMoves.splice(index, 1);
              void this.plugin.saveSettings().then(() => this.display());
            }));
      }
    }

    const history = this.plugin.settings.history ?? [];
    advanced.createEl("h3", { text: "Recent moves" });
    if (!history.length) {
      advanced.createEl("p", { text: "No moves yet." });
    } else {
      for (const [index, item] of history.slice(0, 10).entries()) {
        const first = item.moves[0];
        new Setting(advanced)
          .setName(first ? first.toPath.split("/").pop() ?? first.toPath : "Move")
          .setDesc(first ? `${first.fromPath} → ${first.toPath}` : item.instruction)
          .addButton((button) => button
            .setButtonText("Undo")
            .onClick(() => void this.plugin.undoMove(item.id)));
      }
    }

    this.plugin.support.addHelpSettings(containerEl);

    const balance = containerEl.createDiv({ cls: "oao-billing-summary" });
    balance.createEl("h3", { text: "Account usage" });
    const freeUsage = balance.createEl("p");
    const paidUsage = balance.createEl("p");
    const usageStatus = balance.createEl("p", { cls: "setting-item-description" });
    const updateUsage = (): void => {
      const free = this.plugin.settings.freeUsesRemaining;
      const paid = this.plugin.settings.purchasedUses;
      freeUsage.setText(Number.isSafeInteger(free) ? `Free runs remaining: ${free}` : "Free runs remaining: not refreshed");
      paidUsage.setText(Number.isSafeInteger(paid) ? `Purchased runs available: ${paid}` : "Purchased runs available: not refreshed");
      usageStatus.setText(this.plugin.settings.billingAccountLinked ? "Usage is shared across this Constance account." : "Connect a Constance account to refresh usage and buy more runs.");
    };
    updateUsage();
    if (this.plugin.settings.billingAccountLinked) {
      void this.plugin.syncBillingBalance().then(updateUsage).catch((error) => this.plugin.support.error("billing.balance.open", error));
    }

    new Setting(balance)
      .setName("Refresh balance")
      .setDesc("Load and save the current free and purchased run balance from Constance.")
      .addButton((button) => button
        .setButtonText("Refresh balance")
        .setDisabled(!this.plugin.settings.billingAccountLinked)
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Refreshing...");
          try {
            await this.plugin.syncBillingBalance();
            updateUsage();
            new Notice("Account usage updated.");
          } catch (error) {
            this.plugin.support.error("billing.balance.refresh", error);
            new Notice("Could not refresh account usage. Try again.");
          } finally {
            button.setDisabled(!this.plugin.settings.billingAccountLinked);
            button.setButtonText("Refresh balance");
          }
        }));

    addBillingAccountSettings(containerEl, {
      state: this.plugin.settings,
      appId: AUTO_ORGANIZER_APP_ID,
      installationId: this.plugin.settings.constanceDeviceId,
      appVersion: manifest.version,
      persist: () => this.plugin.saveSettings(),
      syncBalance: async () => {
        await this.plugin.syncBillingBalance();
        updateUsage();
      },
      refresh: () => this.display()
    });

    addLivePacks(containerEl, {
      state: this.plugin.settings,
      appId: AUTO_ORGANIZER_APP_ID,
      installationId: this.plugin.settings.constanceDeviceId,
      persist: () => this.plugin.saveSettings(),
      syncBalance: async () => {
        await this.plugin.syncBillingBalance();
        updateUsage();
      }
    });

    const footer = containerEl.createDiv({ cls: "oao-version" });
    footer.createEl("small", { text: `Hudson Auto Organizer AI ${manifest.version}` });
  }
}
