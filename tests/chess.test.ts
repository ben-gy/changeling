import { describe, expect, it } from 'vitest';
import {
  BISHOP,
  CASTLE_BK,
  CASTLE_BQ,
  CASTLE_WK,
  CASTLE_WQ,
  FLAG_CASTLE_K,
  FLAG_EP,
  FLAG_KEEP,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  clonePosition,
  findMove,
  genLegal,
  genPseudo,
  inCheck,
  initialPosition,
  makeMove,
  mkMove,
  moveText,
  moveTo,
  moveFlag,
  outcomeOf,
  positionKey,
  resultType,
  sq,
  unmakeMove,
  type Color,
  type Position,
  type Variant,
} from '../src/chess';
import { MODES, variantFor } from '../src/modes';
import { makeRng } from '../src/engine/rng';

const CLASSIC: Variant = MODES.classic.variant;
const SKIRMISH: Variant = MODES.skirmish.variant;

/** Build a sparse position for a specific rule case. */
function position(v: Variant, spec: Array<[number, number]>, turn: Color = 1): Position {
  const b = new Int8Array(v.w * v.h);
  let kw = -1;
  let kb = -1;
  for (const [s, pc] of spec) {
    b[s] = pc;
    if (pc === KING) kw = s;
    if (pc === -KING) kb = s;
  }
  return { b, turn, castling: 0, ep: -1, half: 0, full: 1, kw, kb };
}

function perft(v: Variant, p: Position, depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of genLegal(v, p)) {
    const u = makeMove(v, p, m);
    n += perft(v, p, depth - 1);
    unmakeMove(v, p, u);
  }
  return n;
}

describe('base chess rules', () => {
  // Morph only changes the board AFTER a capture, and no capture is possible in
  // the first two plies, so plies 1-3 must reproduce standard chess perft
  // exactly. That pins the whole move generator against a published number.
  it('reproduces standard chess perft for the first three plies', () => {
    const p = initialPosition(CLASSIC);
    expect(perft(CLASSIC, p, 1)).toBe(20);
    expect(perft(CLASSIC, p, 2)).toBe(400);
    expect(perft(CLASSIC, p, 3)).toBe(8902);
  });

  it('detects fool’s mate', () => {
    const v = CLASSIC;
    const p = initialPosition(v);
    const moves: Array<[string, string]> = [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4'],
    ];
    for (const [from, to] of moves) {
      const m = findMove(v, p, name(v, from), name(v, to));
      expect(m).not.toBeNull();
      makeMove(v, p, m as number);
    }
    const out = outcomeOf(v, p);
    expect(out.over).toBe(true);
    if (out.over) {
      expect(out.reason).toBe('checkmate');
      expect(out.winner).toBe(-1);
    }
  });

  it('finds stalemate rather than calling it a win', () => {
    // Black king a8, white queen c7, white king a1 — black to move, not in check,
    // no legal move.
    const p = position(
      CLASSIC,
      [
        [sq(CLASSIC, 0, 7), -KING],
        [sq(CLASSIC, 2, 6), QUEEN],
        [sq(CLASSIC, 0, 0), KING],
      ],
      -1,
    );
    expect(inCheck(CLASSIC, p)).toBe(false);
    const out = outcomeOf(CLASSIC, p);
    expect(out.over && out.reason).toBe('stalemate');
    expect(out.over && out.winner).toBe(0);
  });

  it('castles, and moving the king revokes both rights', () => {
    const v = CLASSIC;
    const p = position(v, [
      [sq(v, 4, 0), KING],
      [sq(v, 7, 0), ROOK],
      [sq(v, 0, 0), ROOK],
      [sq(v, 4, 7), -KING],
    ]);
    p.castling = CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ;
    const castle = genLegal(v, p).find((m) => moveFlag(m) === FLAG_CASTLE_K);
    expect(castle).toBeDefined();
    const u = makeMove(v, p, castle as number);
    expect(p.b[sq(v, 6, 0)]).toBe(KING);
    expect(p.b[sq(v, 5, 0)]).toBe(ROOK);
    expect(p.castling & (CASTLE_WK | CASTLE_WQ)).toBe(0);
    unmakeMove(v, p, u);
    expect(p.b[sq(v, 4, 0)]).toBe(KING);
    expect(p.b[sq(v, 7, 0)]).toBe(ROOK);
    expect(p.castling & CASTLE_WK).toBe(CASTLE_WK);
  });

  it('make/unmake restores the position exactly over long random playouts', () => {
    for (const v of [CLASSIC, SKIRMISH]) {
      const rng = makeRng(`fuzz-${v.w}`);
      const p = initialPosition(v);
      for (let i = 0; i < 60; i++) {
        const legal = genLegal(v, p);
        if (legal.length === 0) break;
        const before = positionKey(p);
        const beforeFull = clonePosition(p);
        const m = legal[Math.floor(rng() * legal.length)];
        const u = makeMove(v, p, m);
        unmakeMove(v, p, u);
        expect(positionKey(p)).toBe(before);
        expect([...p.b]).toEqual([...beforeFull.b]);
        expect(p.kw).toBe(beforeFull.kw);
        expect(p.kb).toBe(beforeFull.kb);
        expect(p.half).toBe(beforeFull.half);
        makeMove(v, p, m);
      }
    }
  });
});

describe('the morph', () => {
  it('turns a queen that eats a pawn into a pawn', () => {
    const v = CLASSIC;
    const p = position(v, [
      [sq(v, 3, 0), QUEEN],
      [sq(v, 3, 4), -PAWN],
      [sq(v, 4, 0), KING],
      [sq(v, 4, 7), -KING],
    ]);
    const m = findMove(v, p, sq(v, 3, 0), sq(v, 3, 4));
    expect(m).not.toBeNull();
    expect(moveText(v, p, m as number)).toBe('Qxd5=P');
    makeMove(v, p, m as number);
    expect(p.b[sq(v, 3, 4)]).toBe(PAWN);
  });

  it('crowns a pawn that eats a queen', () => {
    const v = CLASSIC;
    const p = position(v, [
      [sq(v, 3, 3), PAWN],
      [sq(v, 4, 4), -QUEEN],
      [sq(v, 4, 0), KING],
      [sq(v, 4, 7), -KING],
    ]);
    const m = findMove(v, p, sq(v, 3, 3), sq(v, 4, 4));
    makeMove(v, p, m as number);
    expect(p.b[sq(v, 4, 4)]).toBe(QUEEN);
  });

  it('leaves the king royal when it captures', () => {
    const v = CLASSIC;
    const p = position(v, [
      [sq(v, 4, 0), KING],
      [sq(v, 5, 1), -ROOK],
      [sq(v, 0, 7), -KING],
    ]);
    const m = findMove(v, p, sq(v, 4, 0), sq(v, 5, 1));
    expect(m).not.toBeNull();
    makeMove(v, p, m as number);
    expect(p.b[sq(v, 5, 1)]).toBe(KING);
    expect(p.kw).toBe(sq(v, 5, 1));
    expect(resultType(KING, ROOK, false)).toBe(KING);
  });

  it('promotes a piece that morphs into a pawn on the last rank', () => {
    // White rook takes a black pawn sitting on rank 8: the rook becomes a pawn,
    // and a pawn on the last rank promotes. The two rules compose rather than
    // fighting, and the generator must therefore offer a promotion choice.
    const v = CLASSIC;
    const p = position(v, [
      [sq(v, 0, 0), ROOK],
      [sq(v, 0, 7), -PAWN],
      [sq(v, 4, 0), KING],
      [sq(v, 4, 6), -KING],
    ]);
    const options = genLegal(v, p).filter(
      (m) => moveTo(m) === sq(v, 0, 7) && (m & 0x7f) === sq(v, 0, 0),
    );
    expect(options).toHaveLength(4);
    const toKnight = options.find((m) => (m >> 14 & 0x7) === KNIGHT) as number;
    makeMove(v, p, toKnight);
    expect(p.b[sq(v, 0, 7)]).toBe(KNIGHT);
  });

  it('is a no-op for en passant (pawn takes pawn)', () => {
    const v = CLASSIC;
    const p = position(v, [
      [sq(v, 3, 4), PAWN],
      [sq(v, 4, 4), -PAWN],
      [sq(v, 4, 0), KING],
      [sq(v, 4, 7), -KING],
    ]);
    p.ep = sq(v, 4, 5);
    const m = genLegal(v, p).find((mm) => moveFlag(mm) === FLAG_EP);
    expect(m).toBeDefined();
    makeMove(v, p, m as number);
    expect(p.b[sq(v, 4, 5)]).toBe(PAWN);
    expect(p.b[sq(v, 4, 4)]).toBe(0);
  });

  it('offers keep-or-take only under elective morph', () => {
    const forced: Variant = { ...CLASSIC, morph: 'forced' };
    const choice: Variant = { ...CLASSIC, morph: 'choice' };
    const spec: Array<[number, number]> = [
      [sq(forced, 3, 0), QUEEN],
      [sq(forced, 3, 4), -PAWN],
      [sq(forced, 4, 0), KING],
      [sq(forced, 4, 7), -KING],
    ];
    const a = position(forced, spec);
    const b = position(choice, spec);
    const target = sq(forced, 3, 4);
    expect(genLegal(forced, a).filter((m) => moveTo(m) === target)).toHaveLength(1);
    const both = genLegal(choice, b).filter((m) => moveTo(m) === target);
    expect(both).toHaveLength(2);
    const keep = both.find((m) => moveFlag(m) === FLAG_KEEP) as number;
    makeMove(choice, b, keep);
    expect(b.b[target]).toBe(QUEEN);
  });

  it('never lets a morph invent castling rights', () => {
    // A piece that becomes a rook on a corner must not resurrect a lost right.
    const v = CLASSIC;
    const p = position(v, [
      [sq(v, 1, 1), BISHOP],
      [sq(v, 0, 0), -ROOK],
      [sq(v, 4, 0), KING],
      [sq(v, 4, 7), -KING],
    ]);
    p.castling = 0;
    const m = findMove(v, p, sq(v, 1, 1), sq(v, 0, 0));
    makeMove(v, p, m as number);
    expect(p.b[sq(v, 0, 0)]).toBe(ROOK);
    expect(p.castling).toBe(0);
  });
});

describe('variants', () => {
  it('sets up a legal 6x6 skirmish board with kings facing', () => {
    const p = initialPosition(SKIRMISH);
    expect(p.b.length).toBe(36);
    expect(Math.abs(p.b[p.kw])).toBe(KING);
    expect(Math.abs(p.b[p.kb])).toBe(KING);
    expect(p.kw % SKIRMISH.w).toBe(p.kb % SKIRMISH.w);
    expect(genLegal(SKIRMISH, p).length).toBeGreaterThan(0);
    // No double-step: every pawn has exactly one forward move at the start.
    const pawnMoves = genPseudo(SKIRMISH, p).filter((m) => Math.abs(p.b[m & 0x7f]) === PAWN);
    expect(pawnMoves).toHaveLength(SKIRMISH.w);
  });

  it('gives wildcourt both sides the identical shuffled back rank', () => {
    for (const seed of [1, 7, 99, 12345]) {
      const v = variantFor(MODES.wildcourt, seed);
      const p = initialPosition(v);
      for (let f = 0; f < v.w; f++) {
        expect(p.b[sq(v, f, 0)]).toBe(-p.b[sq(v, f, v.h - 1)]);
      }
      expect([...v.backRank].sort().join('')).toBe('BBKNNQRR');
    }
  });

  it('derives the same wildcourt board from the same seed on every peer', () => {
    const a = variantFor(MODES.wildcourt, 424242);
    const b = variantFor(MODES.wildcourt, 424242);
    expect(a.backRank).toBe(b.backRank);
    expect(positionKey(initialPosition(a))).toBe(positionKey(initialPosition(b)));
  });
});

function name(v: Variant, s: string): number {
  return sq(v, s.charCodeAt(0) - 97, Number(s[1]) - 1);
}

describe('move plumbing', () => {
  it('rejects an out-of-turn or illegal from/to off the wire', () => {
    const v = CLASSIC;
    const p = initialPosition(v);
    expect(findMove(v, p, sq(v, 4, 6), sq(v, 4, 4))).toBeNull(); // black moving on white's turn
    expect(findMove(v, p, sq(v, 4, 1), sq(v, 4, 5))).toBeNull(); // pawn teleport
    expect(findMove(v, p, sq(v, 4, 1), sq(v, 4, 3))).not.toBeNull();
  });

  it('round-trips a packed move', () => {
    const m = mkMove(12, 63, QUEEN, FLAG_KEEP);
    expect(m & 0x7f).toBe(12);
    expect(moveTo(m)).toBe(63);
    expect((m >> 14) & 0x7).toBe(QUEEN);
    expect(moveFlag(m)).toBe(FLAG_KEEP);
  });
});
