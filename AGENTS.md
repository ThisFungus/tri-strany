# Tři strany — agent rules

Online two-player quiz (AZ-kvíz-style mechanics, original name and look), published as a claude.ai artifact.

## Deploy
- Live: https://claude.ai/artifact/2QxxogcR7NAFoUeBrSXnzN. Publish with the Artifact tool: `file_path` = `index.html`, `files` = `{questions.js, game.js, sound.js, app.js}`, `url` = the link above. Omit `capabilities` on redeploys (declared: `db: {}`, `user: {scopes: ["profile"]}`).
- `index.html` has no doctype/html/head/body: the artifact skeleton adds them. For local testing wrap it in a throwaway copy with `<meta charset="utf-8">`, serve the folder over http, delete the copy after.

- GitHub Pages (public link, no accounts): `.github/workflows/pages.yml` runs `scripts/build-pages.sh`, which wraps `index.html` in a full document and adds PeerJS + `p2p.js`. Repo settings → Pages → Source must be "GitHub Actions". Local check: `sh scripts/build-pages.sh` and serve `_site/`; two tabs of one browser act as two players.

## Architecture
- `p2p.js` (Pages build only): db-shaped adapter over PeerJS. Creator's browser hosts the room (`tristrany-<first code>`), accepts writes only at rev+1, broadcasts; guests mirror. Host keeps rooms in localStorage and resumes after reload; guests reconnect after 7 s without a ping.
- `game.js`: pure rules and state transitions (every move returns a new state with `rev+1` or null). Node-testable.
- `app.js`: UI + sync. Online state = one db doc `games/<CODE>`; each move does get → rev check → set. Spectators never write. Timeouts: responsible client at the deadline, the other player after 2.5 s.
- `questions.js`: `open: [clue, [answer, ...variants]]`, `yesno: [question, bool]`. Field letter derives from the first answer.

## Decisions (Marek)
- 2026-11-13: Czech UI and questions. ("Czech (Recommended)")
- 2026-11-13: Judging = auto-check with typo/diacritics tolerance; opponent can accept a near-miss. ("Auto + override (Recommended)")
- 2026-11-13: Git commits must not expose the personal email; use the GitHub noreply address. ("set git and make it email-less. I have github")
- 2026-11-13: Friends must be able to join from one plain link, no accounts → GitHub Pages + peer-to-peer build alongside the artifact. ("I wanna send them just a simple link" / "Yes, build it")
- 2026-11-13: Modes besides classic: semifinal and final. ("semifinal has 1-26 numbers, and finals A-Z letters, sorted from the top node"; then "board size is the same" / "Final: A-Z, semifinal 1-26".) A 28-field triangle can't hold 26, so: semifinal 1–28, final 28 Czech letters A B C Č D E F G H CH I J K L M N O P R Ř S Š T U V Y Z Ž from the top. Semifinal shows the answer's letter after the pick (agent default).
- 2026-11-13: Sounds "similar like in real AZ-kviz": original synthesized cues in `sound.js` (no copied show audio), mute toggle per browser.
- Agent choice: original name/look instead of AZ-kvíz branding; dark house style (app-design skill); single dark theme.
