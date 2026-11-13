import { AbstractInputSuggest, App } from "obsidian";

export class DestinationSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private readonly destinationInput: HTMLInputElement, private readonly destinations: string[], private readonly files: boolean, private readonly choose: (path: string) => void) {
    super(app, destinationInput);
  }

  getSuggestions(query: string): string[] {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return this.destinations.filter((path) => terms.every((term) => (path === "/" ? "Vault root /" : path).toLocaleLowerCase().includes(term)));
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.addClass("oao-destination-suggestion");
    el.createDiv({ text: path === "/" ? "Vault root" : this.files ? path.split("/").pop()! : path });
    if (this.files) el.createEl("small", { text: path });
  }

  selectSuggestion(path: string, event: MouseEvent | KeyboardEvent): void {
    event.preventDefault();
    this.destinationInput.value = path;
    this.choose(path);
    this.close();
  }
}
