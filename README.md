# Hudson Auto Organizer AI

Organize notes with per-vault folder rules, manual filing, optional move learning and AI routing. This plugin is desktop-only.

## Use

Enable the plugin and open its settings. Keep the PARA default or save your own organization rules. Right-click a note, selection or folder to choose manual destinations, organize with AI or inspect duplicates. Preview files and lines before applying, or choose the automatic folder workflow in settings. Stop leaves remaining items pending. Use Undo last Auto Organize run to restore supported changes; later edits are protected.

Manual destinations and line filing work without AI credits. Exact duplicate checks compare full note contents locally. Deleted copies move into a recoverable Deleted folder; they are not permanently removed. Review and operation reports stay in the vault.

## AI and accounts

Configure your own OpenAI key through Obsidian Secret Storage, or choose OpenRouter in settings. OpenRouter is the default provider for new installations. The managed OpenRouter key has a USD $1 lifetime limit with no reset. Existing saved provider choices are preserved. AI routing sends bounded note excerpts and relevant destination excerpts to the selected provider. Duplicate similarity checks send selected excerpts for embeddings. Organization rules are saved separately for each vault. No owner rules or provider credentials are included in the public package.

AI planning uses a connected Constance account and organize-run credits, including planning cancelled after a response. Manual filing and local duplicate previews do not use AI credits. Current offers and balances come from Constance at https://app.tutivsoft.com. Open the checkout link returned by that service. A browser return alone does not grant credits.

## Privacy and recovery

Settings, session credentials, rules and undo history are stored locally. Notes stay local except the excerpts sent for requested AI actions. Account requests do not include note bodies. Anonymous fixed-name usage events use the existing analytics service. Diagnostic logs stay local unless you copy and share them. Do not share keys or session tokens.

## Version 3.16.7

Fix routing privacy, duplicate workflows, and attachment handling.

Requires Obsidian 1.11.4 or later. [GitHub releases](https://github.com/tutivsoft-com/Hudson-Auto-Organizer-AI/releases).
