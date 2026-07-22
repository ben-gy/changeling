// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * chess.ts — the rules engine for Changeling.
 *
 * Real chess, with exactly one rule bolted on:
 *
 *   THE MORPH — when a piece captures, it becomes the TYPE of the piece it
 *   captured. The king is immune (it captures and stays royal, so checkmate
 *   still means what it always meant).
 *
 * Everything else is standard: castling, en passant, promotion, stalemate,
 * threefold, fifty-move. Promotion is applied AFTER the morph, which keeps one
 * uniform rule rather than a pile of exceptions:
 *
 *   result type = mover is king      -> KING
 *                 else captured != 0 -> captured type      (the morph)
 *                 else               -> mover type
 *   then, if that result is a PAWN standing on its promotion rank, it promotes.
 *
 * So a queen taking a pawn on the last rank becomes a pawn and immediately
 * promotes back — a legal no-op, and the only place the two rules interact.
 *
 * Representation is a plain mailbox `Int8Array` of w*h squares with signed
 * pieces (+ white, - black) and make/unmake against an undo record, because the
 * balance sim (tests/balance.test.ts) plays hundreds of full AI-vs-AI games
 * inside the default `npm test` run and an immutable board would not fit.
 */

// ── piece types ─────────────────────────────────────────────────────────────
export const EMPTY = 0;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export type PieceType = 1 | 2 | 3 | 4 | 5 | 6;
export type Color = 1 | -1;

export const WHITE: Color = 1;
export const BLACK: Color = -1;

/** Letters used in move text and setup strings. */
export const TYPE_LETTER = ['', 'P', 'N', 'B', 'R', 'Q', 'K'] as const;

export function letterToType(ch: string): PieceType {
  const i = (TYPE_LETTER as readonly string[]).indexOf(ch.toUpperCase());
  if (i < 1) throw new Error(`bad piece letter "${ch}"`);
  return i as PieceType;
}

// ── variant ─────────────────────────────────────────────────────────────────

export interface Variant {
  /** Files. */
  w: number;
  /** Ranks. */
  h: number;
  /** Back-rank arrangement, file 0..w-1, e.g. "RNBQKBNR". Both colours use it. */
  backRank: string;
  /** Pawns may open with a two-square advance. */
  doubleStep: boolean;
  /** Castling available (needs a standard king-between-rooks back rank). */
  castling: boolean;
  /**
   * 'forced'  — a capture ALWAYS morphs the capturing piece (the headline rule).
   * 'choice'  — the capturer may keep its own type instead. Kept as a real,
   *             generation-level lever from day one because it is the tuning
   *             knob the balance sim would reach for first if the morph turned
   *             out to snowball. See tests/balance.test.ts for what it measured.
   */
  morph: 'forced' | 'choice';
}

export const sq = (v: Variant, file: number, rank: number): number => rank * v.w + file;
export const fileOf = (v: Variant, s: number): number => s % v.w;
export const rankOf = (v: Variant, s: number): number => (s / v.w) | 0;
/** The rank a pawn of `color` promotes on. */
export const promoRank = (v: Variant, color: Color): number => (color === WHITE ? v.h - 1 : 0);
/** The rank pawns of `color` start on. */
export const pawnRank = (v: Variant, color: Color): number => (color === WHITE ? 1 : v.h - 2);

export function squareName(v: Variant, s: number): string {
  return String.fromCharCode(97 + fileOf(v, s)) + (rankOf(v, s) + 1);
}

// ── moves ───────────────────────────────────────────────────────────────────
// Packed into one integer so the search can hold them in a plain number[].
//   bits  0..6  from
//   bits  7..13 to
//   bits 14..16 promotion type (0 = none)
//   bits 17..19 flag

export const FLAG_NONE = 0;
export const FLAG_DOUBLE = 1;
export const FLAG_EP = 2;
export const FLAG_CASTLE_K = 3;
export const FLAG_CASTLE_Q = 4;
/** Elective-morph variants only: capture but KEEP your own type. */
export const FLAG_KEEP = 5;

export type Move = number;

export const mkMove = (from: number, to: number, promo = 0, flag = FLAG_NONE): Move =>
  from | (to << 7) | (promo << 14) | (flag << 17);

export const moveFrom = (m: Move): number => m & 0x7f;
export const moveTo = (m: Move): number => (m >> 7) & 0x7f;
export const movePromo = (m: Move): number => (m >> 14) & 0x7;
export const moveFlag = (m: Move): number => (m >> 17) & 0x7;

// ── position ────────────────────────────────────────────────────────────────

export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

export interface Position {
  b: Int8Array;
  turn: Color;
  castling: number;
  /** En-passant target square, or -1. */
  ep: number;
  /** Halfmove clock for the fifty-move rule. */
  half: number;
  /** Full move number, starting at 1. */
  full: number;
  /** King squares, tracked incrementally so legality checks stay cheap. */
  kw: number;
  kb: number;
}

export interface Undo {
  move: Move;
  /** The piece that stood on `from` BEFORE the morph/promotion rewrote it. */
  moved: number;
  captured: number;
  capturedSq: number;
  castling: number;
  ep: number;
  half: number;
  kw: number;
  kb: number;
}

export function clonePosition(p: Position): Position {
  return { ...p, b: Int8Array.from(p.b) };
}

/**
 * Build the opening position. `order` overrides the variant back rank (used by
 * Wildcourt, whose arrangement is shuffled from the shared round seed — the same
 * arrangement for BOTH sides, so the opening is mirror-symmetric and no seat can
 * draw a better board).
 */
export function initialPosition(v: Variant, order = v.backRank): Position {
  if (order.length !== v.w) throw new Error(`back rank "${order}" != ${v.w} files`);
  const b = new Int8Array(v.w * v.h);
  let kw = -1;
  let kb = -1;
  for (let f = 0; f < v.w; f++) {
    const t = letterToType(order[f]);
    b[sq(v, f, 0)] = t;
    b[sq(v, f, v.h - 1)] = -t;
    if (t === KING) {
      kw = sq(v, f, 0);
      kb = sq(v, f, v.h - 1);
    }
    b[sq(v, f, pawnRank(v, WHITE))] = PAWN;
    b[sq(v, f, pawnRank(v, BLACK))] = -PAWN;
  }
  if (kw < 0 || kb < 0) throw new Error(`back rank "${order}" has no king`);
  return {
    b,
    turn: WHITE,
    castling: v.castling ? CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ : 0,
    ep: -1,
    half: 0,
    full: 1,
    kw,
    kb,
  };
}

// ── attack detection ────────────────────────────────────────────────────────

const KNIGHT_D: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];
const DIAG_D: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const ORTHO_D: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const KING_D = [...DIAG_D, ...ORTHO_D];

/** Is `target` attacked by any piece of `by`? */
export function attacked(v: Variant, p: Position, target: number, by: Color): boolean {
  const b = p.b;
  const tf = fileOf(v, target);
  const tr = rankOf(v, target);

  // Pawns: a pawn of `by` attacks `target` if it sits one rank "behind" it.
  const pr = tr - by;
  if (pr >= 0 && pr < v.h) {
    if (tf > 0 && b[pr * v.w + tf - 1] === by * PAWN) return true;
    if (tf < v.w - 1 && b[pr * v.w + tf + 1] === by * PAWN) return true;
  }
  for (const [df, dr] of KNIGHT_D) {
    const f = tf + df;
    const r = tr + dr;
    if (f < 0 || f >= v.w || r < 0 || r >= v.h) continue;
    if (b[r * v.w + f] === by * KNIGHT) return true;
  }
  for (const [df, dr] of KING_D) {
    const f = tf + df;
    const r = tr + dr;
    if (f < 0 || f >= v.w || r < 0 || r >= v.h) continue;
    if (b[r * v.w + f] === by * KING) return true;
  }
  for (const [df, dr] of DIAG_D) {
    let f = tf + df;
    let r = tr + dr;
    while (f >= 0 && f < v.w && r >= 0 && r < v.h) {
      const pc = b[r * v.w + f];
      if (pc !== 0) {
        if (pc === by * BISHOP || pc === by * QUEEN) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }
  for (const [df, dr] of ORTHO_D) {
    let f = tf + df;
    let r = tr + dr;
    while (f >= 0 && f < v.w && r >= 0 && r < v.h) {
      const pc = b[r * v.w + f];
      if (pc !== 0) {
        if (pc === by * ROOK || pc === by * QUEEN) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }
  return false;
}

export const kingSquare = (p: Position, c: Color): number => (c === WHITE ? p.kw : p.kb);

export function inCheck(v: Variant, p: Position, c: Color = p.turn): boolean {
  return attacked(v, p, kingSquare(p, c), -c as Color);
}

// ── move generation ─────────────────────────────────────────────────────────

/**
 * What type does a piece END UP as after this capture? This single function is
 * the whole game, and both the generator (to know whether a promotion choice is
 * needed) and make() (to write the square) go through it.
 */
export function resultType(moverType: number, capturedType: number, keep: boolean): number {
  if (moverType === KING) return KING;
  if (capturedType === 0 || keep) return moverType;
  return capturedType;
}

function pushMove(
  v: Variant,
  out: Move[],
  from: number,
  to: number,
  moverType: number,
  capturedType: number,
  color: Color,
  flag: number,
  keep = false,
): void {
  const res = resultType(moverType, capturedType, keep);
  const baseFlag = keep ? FLAG_KEEP : flag;
  if (res === PAWN && rankOf(v, to) === promoRank(v, color)) {
    // The end state is a pawn on the last rank, so it promotes — whether it got
    // there by walking, by morphing into a pawn, or both.
    out.push(mkMove(from, to, QUEEN, baseFlag));
    out.push(mkMove(from, to, ROOK, baseFlag));
    out.push(mkMove(from, to, BISHOP, baseFlag));
    out.push(mkMove(from, to, KNIGHT, baseFlag));
  } else {
    out.push(mkMove(from, to, 0, baseFlag));
  }
}

/** Both the forced move and, under elective morph, the keep-your-shape variant. */
function pushCapture(
  v: Variant,
  out: Move[],
  from: number,
  to: number,
  moverType: number,
  capturedType: number,
  color: Color,
  flag: number,
): void {
  pushMove(v, out, from, to, moverType, capturedType, color, flag, false);
  if (v.morph === 'choice' && moverType !== KING && capturedType !== moverType) {
    pushMove(v, out, from, to, moverType, capturedType, color, flag, true);
  }
}

/** Pseudo-legal moves (may leave the mover's king in check). */
export function genPseudo(v: Variant, p: Position, out: Move[] = []): Move[] {
  const b = p.b;
  const us = p.turn;
  const n = v.w * v.h;
  for (let from = 0; from < n; from++) {
    const pc = b[from];
    if (pc === 0 || Math.sign(pc) !== us) continue;
    const type = Math.abs(pc);
    const ff = fileOf(v, from);
    const fr = rankOf(v, from);

    if (type === PAWN) {
      const dir = us;
      const one = fr + dir;
      if (one >= 0 && one < v.h) {
        const s1 = one * v.w + ff;
        if (b[s1] === 0) {
          pushMove(v, out, from, s1, PAWN, 0, us, FLAG_NONE);
          if (v.doubleStep && fr === pawnRank(v, us)) {
            const two = fr + 2 * dir;
            const s2 = two * v.w + ff;
            if (two >= 0 && two < v.h && b[s2] === 0) {
              out.push(mkMove(from, s2, 0, FLAG_DOUBLE));
            }
          }
        }
        for (const df of [-1, 1]) {
          const cf = ff + df;
          if (cf < 0 || cf >= v.w) continue;
          const cs = one * v.w + cf;
          const target = b[cs];
          if (target !== 0 && Math.sign(target) !== us) {
            pushCapture(v, out, from, cs, PAWN, Math.abs(target), us, FLAG_NONE);
          } else if (cs === p.ep) {
            // En passant: pawn takes pawn, so the morph is a no-op by definition.
            out.push(mkMove(from, cs, 0, FLAG_EP));
          }
        }
      }
      continue;
    }

    const slide = type === BISHOP || type === ROOK || type === QUEEN;
    const dirs =
      type === KNIGHT ? KNIGHT_D : type === BISHOP ? DIAG_D : type === ROOK ? ORTHO_D : KING_D;
    for (const [df, dr] of dirs) {
      let f = ff + df;
      let r = fr + dr;
      while (f >= 0 && f < v.w && r >= 0 && r < v.h) {
        const to = r * v.w + f;
        const target = b[to];
        if (target === 0) {
          pushMove(v, out, from, to, type, 0, us, FLAG_NONE);
        } else {
          if (Math.sign(target) !== us) {
            pushCapture(v, out, from, to, type, Math.abs(target), us, FLAG_NONE);
          }
          break;
        }
        if (!slide) break;
        f += df;
        r += dr;
      }
    }

    if (type === KING && v.castling) {
      const back = us === WHITE ? 0 : v.h - 1;
      const kSide = us === WHITE ? CASTLE_WK : CASTLE_BK;
      const qSide = us === WHITE ? CASTLE_WQ : CASTLE_BQ;
      const them = -us as Color;
      if (p.castling & kSide) {
        const rookSq = sq(v, v.w - 1, back);
        if (b[rookSq] === us * ROOK && b[from + 1] === 0 && b[from + 2] === 0) {
          if (
            !attacked(v, p, from, them) &&
            !attacked(v, p, from + 1, them) &&
            !attacked(v, p, from + 2, them)
          ) {
            out.push(mkMove(from, from + 2, 0, FLAG_CASTLE_K));
          }
        }
      }
      if (p.castling & qSide) {
        const rookSq = sq(v, 0, back);
        if (
          b[rookSq] === us * ROOK &&
          b[from - 1] === 0 &&
          b[from - 2] === 0 &&
          b[from - 3] === 0
        ) {
          if (
            !attacked(v, p, from, them) &&
            !attacked(v, p, from - 1, them) &&
            !attacked(v, p, from - 2, them)
          ) {
            out.push(mkMove(from, from - 2, 0, FLAG_CASTLE_Q));
          }
        }
      }
    }
  }
  return out;
}

/** Where the rook comes from and lands, given the king's ORIGIN square. */
function castleRookSquares(
  v: Variant,
  color: Color,
  kingFrom: number,
  flag: number,
): [number, number] {
  const back = color === WHITE ? 0 : v.h - 1;
  return flag === FLAG_CASTLE_K
    ? [sq(v, v.w - 1, back), kingFrom + 1]
    : [sq(v, 0, back), kingFrom - 1];
}

export function makeMove(v: Variant, p: Position, m: Move): Undo {
  const from = moveFrom(m);
  const to = moveTo(m);
  const flag = moveFlag(m);
  const promo = movePromo(m);
  const b = p.b;
  const moved = b[from];
  const color = (moved > 0 ? 1 : -1) as Color;

  let capturedSq = to;
  let captured = b[to];
  if (flag === FLAG_EP) {
    capturedSq = to - color * v.w;
    captured = b[capturedSq];
  }

  const u: Undo = {
    move: m,
    moved,
    captured,
    capturedSq,
    castling: p.castling,
    ep: p.ep,
    half: p.half,
    kw: p.kw,
    kb: p.kb,
  };

  if (captured !== 0) b[capturedSq] = 0;
  b[from] = 0;

  let type = resultType(Math.abs(moved), Math.abs(captured), flag === FLAG_KEEP);
  if (type === PAWN && rankOf(v, to) === promoRank(v, color)) type = promo || QUEEN;
  b[to] = color * type;

  if (type === KING || Math.abs(moved) === KING) {
    if (color === WHITE) p.kw = to;
    else p.kb = to;
  }

  if (flag === FLAG_CASTLE_K || flag === FLAG_CASTLE_Q) {
    const [rFrom, rTo] = castleRookSquares(v, color, from, flag);
    b[rFrom] = 0;
    b[rTo] = color * ROOK;
  }

  // Castling rights only ever get REMOVED: a piece that morphs into a rook and
  // happens to stand on a corner does not conjure a new right.
  if (p.castling) {
    const back = color === WHITE ? 0 : v.h - 1;
    const kMask = color === WHITE ? CASTLE_WK : CASTLE_BK;
    const qMask = color === WHITE ? CASTLE_WQ : CASTLE_BQ;
    if (Math.abs(moved) === KING) p.castling &= ~(kMask | qMask);
    if (from === sq(v, v.w - 1, back)) p.castling &= ~kMask;
    if (from === sq(v, 0, back)) p.castling &= ~qMask;
    const oBack = color === WHITE ? v.h - 1 : 0;
    const oK = color === WHITE ? CASTLE_BK : CASTLE_WK;
    const oQ = color === WHITE ? CASTLE_BQ : CASTLE_WQ;
    if (to === sq(v, v.w - 1, oBack)) p.castling &= ~oK;
    if (to === sq(v, 0, oBack)) p.castling &= ~oQ;
  }

  p.ep = flag === FLAG_DOUBLE ? from + color * v.w : -1;
  p.half = captured !== 0 || Math.abs(moved) === PAWN ? 0 : p.half + 1;
  if (color === BLACK) p.full++;
  p.turn = -color as Color;
  return u;
}

export function unmakeMove(v: Variant, p: Position, u: Undo): void {
  const m = u.move;
  const from = moveFrom(m);
  const to = moveTo(m);
  const flag = moveFlag(m);
  const b = p.b;
  const color = (u.moved > 0 ? 1 : -1) as Color;

  if (flag === FLAG_CASTLE_K || flag === FLAG_CASTLE_Q) {
    const [rFrom, rTo] = castleRookSquares(v, color, from, flag);
    b[rTo] = 0;
    b[rFrom] = color * ROOK;
  }

  b[from] = u.moved;
  b[to] = 0;
  if (u.captured !== 0) b[u.capturedSq] = u.captured;

  p.castling = u.castling;
  p.ep = u.ep;
  p.half = u.half;
  p.kw = u.kw;
  p.kb = u.kb;
  if (color === BLACK) p.full--;
  p.turn = color;
}

/** Fully legal moves. */
export function genLegal(v: Variant, p: Position): Move[] {
  const out: Move[] = [];
  const pseudo = genPseudo(v, p);
  const us = p.turn;
  for (const m of pseudo) {
    const u = makeMove(v, p, m);
    if (!attacked(v, p, kingSquare(p, us), -us as Color)) out.push(m);
    unmakeMove(v, p, u);
  }
  return out;
}

// ── outcomes ────────────────────────────────────────────────────────────────

export type Outcome =
  | { over: false }
  | {
      over: true;
      /** 1 = white wins, -1 = black wins, 0 = draw. */
      winner: 0 | 1 | -1;
      reason: 'checkmate' | 'stalemate' | 'fifty' | 'repetition' | 'material' | 'timeout' | 'resign';
    };

/** Only kings left — nobody can ever mate, and no morph can create material. */
export function bareKings(p: Position): boolean {
  for (let i = 0; i < p.b.length; i++) {
    const pc = p.b[i];
    if (pc !== 0 && Math.abs(pc) !== KING) return false;
  }
  return true;
}

/** Compact key for threefold repetition. Board + side + rights + ep. */
export function positionKey(p: Position): string {
  let s = '';
  for (let i = 0; i < p.b.length; i++) s += String.fromCharCode(p.b[i] + 8);
  return `${s}|${p.turn}|${p.castling}|${p.ep}`;
}

export function outcomeOf(
  v: Variant,
  p: Position,
  history: Map<string, number> = new Map(),
): Outcome {
  const legal = genLegal(v, p);
  if (legal.length === 0) {
    if (inCheck(v, p)) return { over: true, winner: (-p.turn as 1 | -1), reason: 'checkmate' };
    return { over: true, winner: 0, reason: 'stalemate' };
  }
  if (bareKings(p)) return { over: true, winner: 0, reason: 'material' };
  if (p.half >= 100) return { over: true, winner: 0, reason: 'fifty' };
  const seen = history.get(positionKey(p)) ?? 0;
  if (seen >= 3) return { over: true, winner: 0, reason: 'repetition' };
  return { over: false };
}

// ── move text ───────────────────────────────────────────────────────────────

/**
 * Human-readable move text that names the morph, because the morph is the whole
 * point and a plain "Qxe5" hides it: `Qxe5=P` reads "the queen took on e5 and is
 * now a pawn".
 */
export function moveText(v: Variant, p: Position, m: Move): string {
  const from = moveFrom(m);
  const to = moveTo(m);
  const flag = moveFlag(m);
  const moved = p.b[from];
  const moverType = Math.abs(moved);
  const color = (moved > 0 ? 1 : -1) as Color;
  if (flag === FLAG_CASTLE_K) return 'O-O';
  if (flag === FLAG_CASTLE_Q) return 'O-O-O';
  const capType = flag === FLAG_EP ? PAWN : Math.abs(p.b[to]);
  let end = resultType(moverType, capType, flag === FLAG_KEEP);
  if (end === PAWN && rankOf(v, to) === promoRank(v, color)) end = movePromo(m) || QUEEN;
  const head = moverType === PAWN ? (capType ? String.fromCharCode(97 + fileOf(v, from)) : '') : TYPE_LETTER[moverType];
  const morph = end !== moverType ? `=${TYPE_LETTER[end]}` : '';
  return `${head}${capType ? 'x' : ''}${squareName(v, to)}${morph}`;
}

/** Find the legal move matching a from/to (+ promotion/keep) pair, or null. */
export function findMove(
  v: Variant,
  p: Position,
  from: number,
  to: number,
  promo = 0,
  keep = false,
): Move | null {
  for (const m of genLegal(v, p)) {
    if (moveFrom(m) !== from || moveTo(m) !== to) continue;
    if ((moveFlag(m) === FLAG_KEEP) !== keep) continue;
    if (promo && movePromo(m) !== promo) continue;
    return m;
  }
  return null;
}
