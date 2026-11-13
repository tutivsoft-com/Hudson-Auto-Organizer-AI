import { App, ItemView, WorkspaceLeaf } from "obsidian";
import { OrganizePlan } from "./organize-plan";
import { PlanReview, ReviewOptions } from "./plan-modal";

export const REVIEW_VIEW_TYPE = "hudson-organizer-review";

export class OrganizerReviewView extends ItemView {
  private review?: PlanReview;
  getViewType(): string { return REVIEW_VIEW_TYPE; }
  getDisplayText(): string { return "Hudson organizer"; }
  getIcon(): string { return "folder-open"; }
  async onOpen(): Promise<void> {
    this.contentEl.addClass("oao-review-view");
    this.contentEl.createEl("p", { text: "Choose a file or folder in Obsidian to start a new organizer review." });
  }
  showReview(plan: OrganizePlan, options: ReviewOptions): void {
    this.review?.onClose();
    this.contentEl.empty();
    const titleEl = this.contentEl.createEl("h2");
    const contentEl = this.contentEl.createDiv({ cls: "oao-review-content" });
    this.review = new PlanReview(plan, options, { app: this.app, rootEl: this.contentEl, titleEl, contentEl, close: () => this.leaf.detach() });
    this.review.open();
  }
  async onClose(): Promise<void> { this.review?.onClose(); }
}

export async function openReviewWindow(app: App, plan: OrganizePlan, options: ReviewOptions): Promise<WorkspaceLeaf> {
  // Obsidian owns the pop-out, title bar, resizing and native maximize controls.
  const screen = app.workspace.containerEl.ownerDocument.defaultView?.screen;
  const leaf = app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0] ?? app.workspace.openPopoutLeaf({ size: { width: screen?.availWidth || 1280, height: screen?.availHeight || 900 } });
  try {
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    if (!(leaf.view instanceof OrganizerReviewView)) throw new Error("The organizer view could not open.");
    leaf.view.showReview(plan, options);
    await app.workspace.revealLeaf(leaf);
    return leaf;
  } catch (error) { leaf.detach(); options.release(); throw error; }
}
