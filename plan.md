# Game Plan: Changeling

## Overview
- **Name:** Changeling
- **Repo name:** changeling
- **Tagline:** Real chess with one rule bolted on — capture a piece and you *become* it.
- **Genre (directory category):** board

## Core Loop
Standard chess. Standard pieces, standard movement, win by checkmate. One rule changes
everything: **the instant one of your pieces captures, it morphs into the type of whatever
it just took.**

Your queen grabs a loose pawn — she *is* a pawn now, sitting deep in enemy territory. Your
last pawn rams the enemy queen — that pawn is a queen. Only the king is immune: it captures
and stays royal, so checkmate still means exactly what it always meant.

The consequence is that every exchange becomes a shape-shift you have to actually *want*.
Recapture math inverts: "winning a pawn" with a rook is usually a disaster, and the piece
you most want to take with is your worst piece. Trades stop being about material and start
being about *what you turn into and where you end up standing*. Material never simply
accumulates — it circulates, which is exactly why an early lead doesn't stick.

- **Win:** checkmate, or opponent's clock flags.
- **Draw:** stalemate, threefold repetition, 50-move rule, bare kings.
- **Tension:** every capture is a decision with two answers (do I want the square, or do I
  want the shape?) and they usually disagree.

## Controls
- **Desktop:** click a piece to select (legal destinations light up), click a square to move.
  Drag-and-drop also works. `Esc` deselects, `U` undo (solo only), `R` restart.
- **Mobile:** tap to select, tap to move — *or* drag the piece to its square via
  `patterns/drag.ts` (tap stays a first-class action; press→drag promotes at ~8px). No D-pad,
  no reach-across aiming; the board is the control surface, which is correct for this shape.
  Squares are `minmax(0,1fr)` so an 8×8 board at 375px still gives ~44px targets.

## Multiplayer
- **Mode:** live P2P (2 players) + full solo vs AI.
- **Shape:** **versus.** Justified, not defaulted: chess *is* a duel — the entire object of
  the game is that two people want opposite things from the same board. Co-op chess would
  mean two people sharing one side against an engine, which removes the decision-making from
  one of them every other turn; shared-world is meaningless on a 64-square board with an
  authoritative rule set. The factory's co-op-first bias is right for arcade and survival
  shapes; it is wrong here, and forcing it would make a worse game.
- **Players:** 2. **Topology: lockstep** (not snapshot). There is zero randomness in play
  and zero hidden information, so each peer broadcasts only `{from, to, promo}` and both
  clients apply the identical forced morph to identical boards. The two boards *cannot*
  drift — there is nothing to desync. Illegal or out-of-turn moves are rejected locally by
  the same move generator on both sides.
- **Channels (≤12 bytes):** `mv` (a move), `clk` (host clock tick), `rsg` (resign / draw
  offer). Round start + seed + frozen roster ride on `rematch.ts`'s own channels.
- **Room entry:** create a room *or* type a 4-char code (`createRoomEntry`). `?room=` is
  honoured once and cleared on the way out.
- **Late joiner:** a third peer is a spectator — it receives the move list and renders the
  board, and is seated in the next round. Seats for a round are frozen by `rematch.ts`.
- **The clock is the only host-authoritative state.** Each side gets a mode-dependent budget
  with increment. The host ticks it on `setInterval` (never rAF — a backgrounded host must
  not freeze the game) and broadcasts `clk`; guests render it and never declare flag-fall.
- **If the host leaves:** `net.ts` promotes the survivor and `onHostChange` calls
  `Session.setHost(true)`. The promoted peer adopts its last received clock values as
  canonical, resumes the tick interval, and becomes the peer that can declare flag-fall and
  drive the rematch. The *game itself* is unaffected because it is lockstep — the board was
  never the host's to own. If the opponent leaves outright, the survivor is offered the win
  and can always reach the results screen; it never freezes.
- **End of round → rematch.** Uses `patterns/rematch.ts` (`createRounds`). The Net stays up
  for the whole session — **never** leave and rejoin. "Play again" is a vote plus a new round
  number; the host broadcasts the new seed and the frozen roster, and **colours swap each
  round** so White is never the same person twice. While waiting, a player sees who has voted
  and a **visible countdown** (`state().startsInMs`) — quorum + grace starts the round, so one
  player still reading the summary cannot hold the room hostage; the host can force start. A
  peer who declines or closes the tab is dropped from the roster and the round starts without
  them. A promoted host inherits an empty tally rather than a bogus one. "Back to lobby" does
  **not** leave the room. A running match tally (W–L–D) persists across rounds.

## Juice Plan
- **The morph is the money shot:** on capture the piece pops to 1.35×, a white flash washes
  the square, the SVG cross-fades to its new shape, and a ring of particles fires in the
  colour of the *gained* type. Sound branches: `powerup` on an upgrade, `hit` on a downgrade,
  and a distinct low thud when a queen collapses to a pawn.
- Screen shake on check (small) and checkmate (large); hit-stop on capture.
- Tweened piece motion (`transform` only, 180ms cubic-bezier). Nothing snaps.
- Legal-move dots grow in with a stagger; capture squares get a ring, not a dot.
- **Material tide bar** at the top — a single bar that slides as material swings. Because
  morph circulates material rather than accumulating it, this thing is constantly moving,
  and watching it whip back after a bad recapture is most of the feedback.
- Last-move trail, check pulse on the king square, `select`/`blip` on pick-up/put-down.
- All shake/particles gated on `prefers-reduced-motion`.

## Style Direction
**Vibe:** clean-minimal with a cold, slightly occult edge (it *is* a changeling).
**Palette:** deep slate board (`#1b2028` / `#252b35`), bone-white pieces (`#f2efe6`) vs
ink-violet pieces (`#3a2f52` with a `#a78bfa` rim so they read on dark). Accents: amber
`#f5b544` (selection / last move), teal `#3fd0c9` (legal moves), rose `#f4708f` (check).
Colour-blind-safe: the two sides differ in **luminance** (bone vs ink) as well as hue, and
every state is also carried by shape (ring vs dot) not colour alone.
**Theme:** dark.
**Reference feel:** the calm of a good analysis board, with the pop of a match-3 on capture.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** DOM/CSS grid. Correct for a board game — crisp text, trivial 44px hit targets,
  free accessibility, and CSS transitions give the tweening for nothing. Pieces are inline
  **procedural SVG** (six hand-authored silhouettes), so there are no font-glyph surprises
  across platforms and the morph can cross-fade between two shapes.
- **Engine modules copied from patterns/:** net, rematch, lobby, rng, sound, storage, drag,
  mobile (+ mobile.css), identity.
- **Core rules module** `src/chess.ts`: `Int8Array` mailbox board, make/unmake with an undo
  stack, pseudo-legal generation + king-attack legality test. Fast enough that the balance
  sim runs hundreds of full AI-vs-AI games inside the default test run.
- **AI** `src/ai.ts`: alpha-beta with MVV-LVA ordering over the **morph-aware** move
  generator (the morph needs no special-casing — it falls out of make/unmake), material +
  piece-square tables, three strengths.
- **Persistence:** localStorage — mute, last mode, AI strength, how-to-play seen, solo
  record, match tally.

## Modes (3, with genuine spread)
| Mode | Board | Setup | Why it plays differently |
|---|---|---|---|
| **Classic** | 8×8 | Standard, castling on | The full game. Openings matter, the morph rewires the middlegame. 10 min + 5s. |
| **Skirmish** | 6×6 | 12 pieces/side, no castling, no double-step | A knife fight. Every capture is a huge proportion of the board, promotion is four ranks away, games run ~20 moves. 3 min + 3s. |
| **Wildcourt** | 8×8 | Seeded **symmetric** shuffled back rank, no castling | No opening theory survives; bishops may start on the same colour, a queen may start in a corner. Both sides get the *identical* arrangement, so it is fair by construction. 8 min + 5s. |

The **host's** mode is what the room plays and it travels frozen inside the round start
(`roundOpts()`); guests render `state().hostOpts`, never their own local pick. Unknown mode
ids off the wire fall back via `modeOf()`.

## Balance (principle #18) — built FIRST, before any tuning
Competitive, so `tests/balance.test.ts` is mandatory and gets written before the game is
tuned. Hundreds of fixed-seed AI-vs-AI games per mode, asserting the *shape*:
- **P(leader at move N eventually wins)** — flat and near chance in the opening, rising only
  late. The named risk here is a snowball via cheap early queen-snatches; the counter-argument
  is that the morph *punishes* greed (take a pawn with your queen and you no longer have a
  queen), and the sim decides which is true. **The diagnosis will probably be wrong; the sim
  referees.**
- **White's seat score** near 50% (chess has a real first-move edge; the assertion band is
  explicit and the measured number is printed, not hidden).
- **Blowout rate** bounded, and **every game terminates** inside the move cap.
- **Feel, not just fairness:** also measure morph frequency and the distribution of morph
  magnitudes. A tuning change that flattens the win curve by making players stop capturing
  has destroyed the game; the sim asserts captures-per-game stays high.
- **Tuning levers, in order:** forced vs elective morph (`morph: 'forced' | 'choice'` is a
  mode field from day one), and the AI's internal piece values.

## Non-Goals
- No opening book, no engine strength beyond a few ply, no analysis/annotation mode.
- No Chess960 castling (Wildcourt simply has no castling).
- No public matchmaking board (a chess duel is a thing you play with someone you know).
- No async-seed mode — a chess position isn't a seeded board; sharing a *game* is a PGN
  feature and out of scope for this run.

## How To Play (player-facing copy)
> It's chess. All the normal rules, win by checkmate.
> **One change: when your piece captures, it turns into whatever it just captured.**
> Take a pawn with your queen and your queen becomes a pawn. Take a queen with a pawn and
> that pawn becomes a queen. Only the king is immune.
> Tap a piece to see its moves, then tap where to go — or just drag it.
