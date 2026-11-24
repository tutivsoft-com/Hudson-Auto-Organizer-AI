# Hudson Auto Organizer AI 3.16.7 release verification

24 November 2026, Windows. This checkpoint covers published files and source inspection. Native UI cases and screenshots are pending.

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

## Desktop cases to run

The exact downloaded bundle is staged in a disposable vault with synthetic greenhouse notes, two equivalent duplicate samples, and separate folders for moves, rules, and exclusions. Windows app launch review rejected the isolated debugging command before launching a process, with the reason `blocked by policy`. The normal installed-app launch with the synthetic vault and no debugging flags is queued behind other shared-desktop tests.

| Surface | Planned cases |
| --- | --- |
| Settings | Simple and Advanced, each folder workflow, provider selection, both model fields, rules path, exclusions, move learning, source sharing, defaults and custom rule validation |
| Entry points | Command palette, ribbon, note/editor context menus, multi-file selection and folder menu |
| Manual review | Folder picker, invalid destination, select all/none, row details, cancel, apply, open destination and undo |
| Line filing | Choose destination, preserve unselected text, verify filed content and restore it |
| Duplicates | Compare exact and similar results, preview identical notes and verify recovery where permitted |
| AI review | Tiny synthetic request, unavailable service, exclusions, plan preview, application, cancellation and reviewed folder mode |
| Account and credits | Signed-out status, balance failure and recovery, disabled or unavailable checkout. Live charges are excluded. |

No new UI test, provider transaction, runtime edit, or publication result is claimed in this checkpoint.