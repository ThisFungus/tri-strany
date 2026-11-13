# Status

## State
- claude.ai artifact v2 (rematch fix) at https://claude.ai/artifact/2QxxogcR7NAFoUeBrSXnzN. Friends need an email invite (Editor on a personal plan).
- GitHub Pages build (public link, no accounts, peer-to-peer via PeerJS) at https://thisfungus.github.io/tri-strany/, deployed by `.github/workflows/pages.yml` on every push to main. Tested locally in two tabs: join by link, moves both ways, steal/reveal, host reload resume, rematch with guest following.
- Not yet tested: two different computers/networks (strict NATs may block a direct connection; there is no TURN relay).

## Verify queue
1. (5 min) Open https://thisfungus.github.io/tri-strany/, create a game, open the copied link on a phone on mobile data, join, play two turns.
2. (10 min) Same with a friend on their own computer.

## Waiting on Marek
- Nothing.

## TODO
- If friends can't connect across networks: add a TURN relay to the PeerJS config.
- Optional: let hosts paste their own question sets.
- Known: clock skew over 2.5 s between players can time out an answerer early.
