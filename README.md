# Hudson Auto Organizer AI

Organize notes with per-vault folder rules, manual filing, optional move learning and AI routing. This plugin is desktop-only.

## Use

Enable the plugin and open its settings. Keep the PARA default or save your own organization rules. Right-click a note, selection or folder to choose manual destinations, organize with AI or inspect duplicates. Preview files and lines before applying, or choose the automatic folder workflow in settings. Stop leaves remaining items pending. Use Undo last Auto Organize run to restore supported changes; later edits are protected.

Manual destinations and line filing work without AI credits. The exact duplicate preview compares full note contents locally after normalizing line endings and trimming outer whitespace. Copies you choose to delete move to the recoverable `Deleted` folder at the vault root. Review and operation reports stay in the vault.

## AI and accounts

OpenAI is the default provider for new installations of 3.16.7. Add your OpenAI key through Obsidian Secret Storage, or choose OpenRouter in Hudson settings. The managed OpenRouter key has a USD 1 lifetime limit with no reset. Version 3.16.7 displays USD 2 in settings. Existing saved provider choices are preserved.

AI routing sends bounded excerpts from source notes and relevant destination notes, along with vault-relative paths, to the selected provider. Compiling custom rules sends your rule text and existing folder paths to that provider. Hudson saves the resulting rules separately for each vault. The similar-note scan first compares up to 200 words from each note locally, then sends excerpts only for likely matches to the provider for embedding. That scan is read-only.

AI routing, folder planning and AI comparisons of similar notes use organize-run credits from a connected Constance account. A completed planning request can use a credit even if you cancel the preview. Manual filing and exact duplicate previews require no AI credits. Current offers and balances come from Constance at https://app.tutivsoft.com. Open the checkout link returned by that service. A browser return alone does not grant credits.

## Privacy and recovery

Settings, session credentials, rules and undo history are stored locally. Account requests do not include note bodies. Matomo receives fixed-name usage events with a randomly generated visitor ID stored locally. Diagnostic logs stay local unless you copy and share them. Keep keys and session tokens private.

## Version 3.16.7

Fix routing privacy, duplicate workflows, and attachment handling.

Requires Obsidian 1.11.4 or later. [GitHub releases](https://github.com/tutivsoft-com/Hudson-Auto-Organizer-AI/releases).
