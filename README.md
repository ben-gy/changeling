# Changeling

**Real chess with one rule bolted on — capture a piece and you become it.**

🎮 Play: https://changeling.benrichardson.dev

## What it is

Changeling is chess. Standard pieces, standard movement, castling, en passant,
promotion, win by checkmate. One rule changes everything:

> **When your piece captures, it turns into whatever it just captured.**

Your queen takes a loose pawn — she *is* a pawn now, sitting deep in enemy
territory. Your last pawn rams the enemy queen — that pawn *is* a queen. Only the
king is immune: it captures and stays royal, so checkmate still means exactly what
it always meant.

The consequence is that every exchange becomes a shape-shift you have to actually
*want*. Recapture math inverts: "winning a pawn" with a rook is usually a
disaster, and the piece you most want to capture with is your worst one. Whoever
recaptures **last** comes out holding the good shape, which means initiating an
exchange is a commitment rather than a free grab. Material stops accumulating and
starts *circulating* — the material bar at the top of the board is in constant
motion, and watching it whip back after a bad recapture is most of the game's
feedback.

Play it solo against a three-strength engine, or with a friend over a room code.

## How to play

- **Desktop:** click a piece to select it (legal destinations light up), then click
  where to go. Drag-and-drop works too. `Esc` deselects.
- **Mobile:** tap to select, tap to move — or just drag the piece to its square.
  No D-pad, no reaching across the board; on a phone the board *is* the control.
- **Goal:** checkmate. Draws by stalemate, threefold repetition, the fifty-move
  rule and bare kings all apply, and each side has a clock.

### Modes

| Mode | Board | What's different |
|---|---|---|
| **Classic** | 8×8 | The full game, castling on. 10 min + 5s. |
| **Skirmish** | 6×6 | 12 pieces a side, no castling, pawns walk one square. A knife fight — every capture is a big fraction of the board and promotion is close. 3 min + 3s. |
| **Wildcourt** | 8×8 | The back rank is shuffled from the round seed — **the same way for both sides**, so it is fair by construction. No opening theory survives. 8 min + 5s. |

## Multiplayer

Two players, live, **peer-to-peer** — your browsers talk directly to each other
over WebRTC. There is no game server, because there is nothing for one to do: the
game is **lockstep**. With zero randomness in play and zero hidden information,
each side broadcasts only `{from, to, promo}` and both clients apply the identical
forced morph to identical boards. The two boards cannot drift.

- Create a room and share the 4-character code, or **type a friend's code** to
  join — the invite link is a convenience, never the only way in.
- Colours swap every round, and a running match tally persists across rematches.
- Rematches happen **inside** the same room; the connection is never torn down.
- The clock is the only host-authoritative state, so if the host leaves, the other
  player is promoted, adopts the clock and the game keeps running — and can still
  finish. If your opponent leaves outright you still reach the results screen,
  never a frozen board.
- A free public signalling relay brokers the initial handshake only. Connecting
  over WebRTC exchanges IP addresses with the peer you invited; no game data
  touches a server of ours.

## Tech

- Vite 6 + vanilla TypeScript
- DOM/CSS rendering, with procedural inline-SVG pieces (no font glyphs, so a
  bishop looks like a bishop on every device)
- `Int8Array` mailbox board with make/unmake, so the balance sim can play hundreds
  of full AI-vs-AI games inside the test run
- Alpha-beta engine with piece-square evaluation over the morph-aware generator
- Shared engine: Trystero P2P netcode, rematch rounds, seeded RNG, procedural audio
- Vitest — 160 tests, including standard-chess perft, P2P lockstep determinism,
  host-transfer takeover, and a balance simulation

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less
page-view counts via Cloudflare Web Analytics.

## Is it balanced?

Measured, not argued. `tests/balance.test.ts` plays hundreds of paired-seed
AI-vs-AI games per mode and asserts the shape of the result. Two findings from it
shaped what shipped:

1. **Raw material is a liar in this variant.** Sampled naively, an early material
   leader appeared to win only ~27% of the time. That was an artifact: capturing
   first hands the recapturer both your freshly-upgraded piece and an upgrade of
   their own, so a material reading taken mid-exchange favours whoever is about to
   be punished. Resolving pending captures first fixed the measurement.
2. **White's first-move edge does not survive the morph.** Over 260 paired games
   of Classic, White scores **46.5%** where ordinary chess gives White ~55% —
   because moving first means more often being the one who *initiates* an
   exchange. No compensation was added, because none was needed.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
