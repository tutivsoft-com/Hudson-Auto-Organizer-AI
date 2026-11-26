# Hudson Auto Organizer AI 3.16.7 release verification

Audit started 24 November and resumed 26 November 2026 on Windows. The released assets and source references passed verification. The first visible launch stopped at vault trust. The later native smoke passed for a manual folder dry run in stock Obsidian 1.15.1.

## Published bundle

The [GitHub release](https://github.com/tutivsoft-com/Hudson-Auto-Organizer-AI/releases/tag/3.16.7) advertised exactly three assets. All three downloads matched their advertised SHA-256 digests and byte-for-byte Git blobs at both the peeled version tag `633a2ac3a3312e6a4c23d7bd42466c7f19e58722` and the audited public main baseline `ff33a3572d86c65cb6e47ad731e7681a7f33853a`. The downloaded JavaScript passed `node --check`. The manifest declares desktop-only support and Obsidian 1.11.4 as the minimum.

| Asset | SHA-256 |
| --- | --- |
| main.js | `aafb9aeada3dd6151a676d67c9d0e99475fb09053f432f54a0bf234f57bb0ddb` |
| manifest.json | `d758d49380b053e49ac604e7890f5c1108a39303cdc83f47dc29bdbd2d32a98b` |
| styles.css | `94c44eb0984cfd08c868ed3a51ea1a30026a63fb96103977911d910a5d03e0ef` |

## Source findings

- The OpenRouter settings description names a USD $2 lifetime managed-key cap. The public README documents the intended USD $1 cap and identifies the displayed amount as stale. The settings text and the documented limit disagree.
- The rules-file action passes a new path directly to Obsidian's vault file creation method. It checks for a folder at the final path, but does not prepare or validate missing parent folders. A nested path whose parent does not exist needs a desktop failure and recovery case.

## Native launch and coverage

The exact release was staged in a disposable vault with synthetic greenhouse notes, two equivalent duplicate samples, and separate folders for moves, rules, and exclusions. On 24 November, host command review rejected the isolated debugging launch before it created a process, citing "blocked by policy". A normal hidden launch created the vault workspace without exposing a visible window. A subsequent visible launch started shortly before the host interrupted the audit.

On 26 November, the regular installed Obsidian 1.15.1 executable opened the isolated Hudson Public QA vault with an ordinary local profile. It displayed "Do you trust the author of this vault?" before enabling community plugins. The trust prompt was left untouched. The audit captured its actual window and closed the isolated Obsidian instance. The exact fixture settings did not affect the existing user vault.

[Native vault trust prompt](01-vault-trust-gate.jpeg) (1026 × 801 JPEG)

## Native startup follow-up

At 16:46 IST on 26 November, the verified 3.16.7 bundle loaded in stock Obsidian 1.15.1 using the previously trusted, isolated Hudson QA vault. The app opened the synthetic welcome note, and a fresh diagnostic log recorded one `plugin.loaded` event for release 3.16.7. The isolated process used the prepared loopback proxy during the launch.

Concurrent Windows input interrupted that attempt before the preview opened. The isolated process was stopped, and the original private synthetic profile and its 3.16.9 files were restored and verified against the backup.

## Native manual dry run passed

At 17:02 IST on 26 November, stock Obsidian 1.15.1 loaded the exact published 3.16.7 bundle in the trusted synthetic fixture. The native command palette opened **Preview folder changes (dry run)**. Selecting **Review Files** and **Choose destinations manually** opened Hudson’s separate review window with two synthetic source cards, version 3.16.7, and zero items selected or applied.

**Cancel** closed the review window. All 38 synthetic Markdown files matched the original fixture by relative path and SHA-256. The diagnostic log recorded `plugin.loaded`, `preview.started`, `preview.completed`, and `review.closed`. The session remained signed out and produced no move history. Obsidian’s background update checks returned `ERR_PROXY_CONNECTION_FAILED` under the scoped loopback proxy. The isolated instance exited and the private 3.16.9 fixture was restored and verified.

- Obsidian command palette with Hudson’s native dry-run command. [Command palette](02-native-command-palette.jpeg)
- Hudson manual preview showing two source cards, zero changes, and the release version. [Manual preview](03-native-manual-preview.jpeg)

## Coverage outside this smoke

| Surface | Cases |
| --- | --- |
| Settings | Simple and Advanced, each folder workflow, provider selection, both model fields, rules path, exclusions, move learning, source sharing, defaults and custom rule validation |
| Entry points | Ribbon, note/editor context menus, multi-file selection and folder menu |
| Manual review | Invalid destination, select all/none, apply, open destination and undo |
| Line filing | Choose destination, preserve unselected text, verify filed content and restore it |
| Duplicates | Compare exact and similar results, preview identical notes and verify recovery where permitted |
| AI review | Tiny synthetic request, unavailable service, exclusions, plan preview, application, cancellation and reviewed folder mode |
| Account and credits | Signed-out status, balance failure and recovery, disabled or unavailable checkout. Live charges are excluded. |
