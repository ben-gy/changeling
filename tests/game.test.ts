/**
 * game.test.ts — the game wrapper: clocks, records, outcomes, and the
 * lockstep-determinism invariant that P2P play rests on.
 */

import { describe, expect, it } from 'vitest';
import { Game, moveSwing } from '../src/game';
import { MODES, modeOf, backRankFor, MODE_IDS } from '../src/modes';
import {
  KING,
  PAWN,
  QUEEN,
  findMove,
  genLegal,
  positionKey,
  sq,
  moveFrom,
  moveTo,
  movePromo,
} from '../src/chess';
import { chooseMove, STRENGTHS, material } from '../src/ai';
import { makeRng } from '../src/engine/rng';

const at = (g: Game, f: number, r: number): number => sq(g.variant, f, r);

describe('Game', () => {
  it('rejects an illegal move without touching the board', () => {
    const g = new Game(MODES.classic, 1);
    const before = positionKey(g.pos);
    expect(g.play(-1)).toBeNull();
    expect(g.play(999999)).toBeNull();
    expect(positionKey(g.pos)).toBe(before);
  });

  it('records a capture as an upgrade or a downgrade, not just a capture', () => {
    const g = new Game(MODES.classic, 1);
    // 1. e4 d5 2. exd5 — a pawn takes a pawn, so nothing changes shape.
    const play = (a: [number, number], b: [number, number]): void => {
      const m = findMove(g.variant, g.pos, at(g, ...a), at(g, ...b));
      expect(m).not.toBeNull();
      g.play(m as number);
    };
    play([4, 1], [4, 3]);
    play([3, 6], [3, 4]);
    play([4, 3], [3, 4]);
    expect(g.records.w.captures).toBe(1);
    expect(g.records.w.upgrades).toBe(0);
    expect(g.records.w.downgrades).toBe(0);

    // ...now the black queen takes that pawn and collapses into one.
    play([3, 7], [3, 4]);
    expect(g.records.b.captures).toBe(1);
    expect(g.records.b.downgrades).toBe(1);
    expect(g.played.at(-1)?.wasType).toBe(QUEEN);
    expect(g.played.at(-1)?.nowType).toBe(PAWN);
  });

  it('prices a move by what LEAVES the board and what you turn into', () => {
    const g = new Game(MODES.classic, 1);
    const v = g.variant;
    // Queen takes pawn: +100 for the pawn, -800 for becoming one.
    g.pos.b.fill(0);
    g.pos.b[sq(v, 3, 0)] = QUEEN;
    g.pos.b[sq(v, 3, 4)] = -PAWN;
    g.pos.b[sq(v, 4, 0)] = KING;
    g.pos.b[sq(v, 4, 7)] = -KING;
    g.pos.kw = sq(v, 4, 0);
    g.pos.kb = sq(v, 4, 7);
    const m = findMove(v, g.pos, sq(v, 3, 0), sq(v, 3, 4)) as number;
    expect(moveSwing(v, g.pos, m)).toBe(100 + (100 - 900));
  });

  it('notices what a player left on the table', () => {
    const g = new Game(MODES.classic, 1);
    const v = g.variant;
    g.pos.b.fill(0);
    g.pos.b[sq(v, 0, 0)] = PAWN; // a pawn that could take a queen
    g.pos.b[sq(v, 1, 1)] = -QUEEN;
    g.pos.b[sq(v, 4, 0)] = KING;
    g.pos.b[sq(v, 7, 7)] = -KING;
    g.pos.kw = sq(v, 4, 0);
    g.pos.kb = sq(v, 7, 7);
    // Shuffle the king sideways instead of taking the queen. (e1-e2 would be
    // illegal — the queen covers it — and a null move records nothing at all.)
    const quiet = findMove(v, g.pos, sq(v, 4, 0), sq(v, 5, 0));
    expect(quiet).not.toBeNull();
    g.play(quiet as number);
    expect(g.records.w.bestMissed?.text).toContain('xb2');
    expect(g.records.w.bestMissed?.swing).toBe(900 + (900 - 100));
  });

  it('flags on time, and only for the side that ran out', () => {
    const g = new Game(MODES.skirmish, 3);
    g.clock.w = 1_000;
    g.tick(500);
    expect(g.outcome().over).toBe(false);
    g.tick(900);
    const out = g.outcome();
    expect(out.over && out.reason).toBe('timeout');
    expect(out.over && out.winner).toBe(-1);
  });

  it('adds the increment to the mover, every move', () => {
    const g = new Game(MODES.classic, 1);
    const before = g.clock.w;
    const m = findMove(g.variant, g.pos, at(g, 4, 1), at(g, 4, 3)) as number;
    g.play(m);
    expect(g.clock.w).toBe(before + MODES.classic.incrementMs);
    expect(g.clock.b).toBe(MODES.classic.clockMs);
  });

  it('summarises BOTH players, always (principle #9)', () => {
    const g = new Game(MODES.classic, 1);
    const s = g.summary();
    expect(s.w).toBeDefined();
    expect(s.b).toBeDefined();
    expect(s.w.material).toBe(-s.b.material);
  });

  it('calls a draw by repetition rather than running forever', () => {
    const g = new Game(MODES.classic, 5);
    const shuffle: Array<[[number, number], [number, number]]> = [
      [[6, 0], [5, 2]],
      [[6, 7], [5, 5]],
      [[5, 2], [6, 0]],
      [[5, 5], [6, 7]],
    ];
    for (let rep = 0; rep < 3; rep++) {
      for (const [a, b] of shuffle) {
        const m = findMove(g.variant, g.pos, at(g, ...a), at(g, ...b));
        if (m === null) continue;
        g.play(m);
      }
    }
    const out = g.outcome();
    expect(out.over && out.reason).toBe('repetition');
  });
});

describe('modes', () => {
  it('falls back safely for an id that came off the wire', () => {
    expect(modeOf('classic').id).toBe('classic');
    expect(modeOf('nope').id).toBe('classic');
    expect(modeOf(undefined).id).toBe('classic');
    // A prototype key must not resolve to a Mode of undefined fields.
    expect(modeOf('constructor').id).toBe('classic');
    expect(modeOf('toString').id).toBe('classic');
    expect(modeOf('__proto__').id).toBe('classic');
  });

  it('gives the three modes genuinely different shapes', () => {
    const sizes = MODE_IDS.map((id) => `${MODES[id].variant.w}x${MODES[id].variant.h}`);
    expect(new Set(sizes).size).toBeGreaterThan(1);
    expect(MODES.skirmish.variant.doubleStep).toBe(false);
    expect(MODES.classic.variant.castling).toBe(true);
    expect(MODES.wildcourt.shuffled).toBe(true);
    // Every mode must be playable, not merely declared.
    for (const id of MODE_IDS) {
      const g = new Game(MODES[id], 99);
      expect(genLegal(g.variant, g.pos).length).toBeGreaterThan(4);
      expect(g.outcome().over).toBe(false);
    }
  });

  it('derives a wildcourt back rank deterministically from the seed', () => {
    expect(backRankFor(MODES.wildcourt, 77)).toBe(backRankFor(MODES.wildcourt, 77));
    const spread = new Set([1, 2, 3, 4, 5, 6].map((s) => backRankFor(MODES.wildcourt, s)));
    expect(spread.size).toBeGreaterThan(1);
    // A non-shuffled mode ignores the seed entirely.
    expect(backRankFor(MODES.classic, 1)).toBe(backRankFor(MODES.classic, 2));
  });
});

describe('P2P lockstep determinism', () => {
  // The whole reason Changeling can be lockstep: same seed + same move list =>
  // byte-identical boards. If this ever fails, two peers are playing different
  // games and no amount of netcode will save them.
  it('two peers replaying the same moves reach the identical position', () => {
    for (const id of MODE_IDS) {
      const a = new Game(MODES[id], 31337);
      const b = new Game(MODES[id], 31337);
      const rng = makeRng(31337);
      for (let i = 0; i < 40; i++) {
        if (a.outcome().over) break;
        const choice = chooseMove(a.variant, a.pos, STRENGTHS.novice, rng);
        if (!choice) break;
        const played = a.play(choice.move);
        expect(played).not.toBeNull();
        // The peer only ever receives from/to/promo — never a board.
        const wire = {
          f: moveFrom(choice.move),
          t: moveTo(choice.move),
          p: movePromo(choice.move),
        };
        const mirrored = findMove(b.variant, b.pos, wire.f, wire.t, wire.p);
        expect(mirrored).not.toBeNull();
        b.play(mirrored as number);
        expect(positionKey(b.pos)).toBe(positionKey(a.pos));
      }
      expect(material(b.pos)).toBe(material(a.pos));
    }
  });

  it('a peer given a different seed does NOT match, so the test can fail', () => {
    const a = new Game(MODES.wildcourt, 1);
    const b = new Game(MODES.wildcourt, 2);
    expect(positionKey(a.pos)).not.toBe(positionKey(b.pos));
  });
});
