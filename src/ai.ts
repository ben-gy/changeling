/**
 * ai.ts — alpha-beta search over the morph-aware move generator.
 *
 * The morph needs no special-casing anywhere in here, which is the nice part:
 * make/unmake already writes the morphed piece onto the board, so a plain
 * material + piece-square evaluation of the resulting position automatically
 * understands that taking a pawn with your queen just cost you 800 points of
 * queen. Only MOVE ORDERING needed rethinking — see `captureGain`.
 */

import {
  BISHOP,
  FLAG_EP,
  FLAG_KEEP,
  KING,
  KNIGHT,
  PAWN,
  QUEEN,
  ROOK,
  attacked,
  fileOf,
  genPseudo,
  kingSquare,
  makeMove,
  moveFlag,
  movePromo,
  moveTo,
  rankOf,
  unmakeMove,
  type Color,
  type Move,
  type Position,
  type Variant,
} from './chess';
import type { Rng } from '@ben-gy/game-engine/rng';

export const VALUE: readonly number[] = [0, 100, 320, 330, 500, 900, 0];

const MATE = 30000;

export interface Strength {
  id: string;
  name: string;
  depth: number;
  /** Random jitter (centipawns) added to root scores, so solo play varies. */
  noise: number;
  /** Hard node budget — the search bails rather than ever hanging a phone. */
  nodes: number;
}

export const STRENGTHS: Record<string, Strength> = {
  novice: { id: 'novice', name: 'Novice', depth: 1, noise: 70, nodes: 30_000 },
  adept: { id: 'adept', name: 'Adept', depth: 2, noise: 18, nodes: 150_000 },
  master: { id: 'master', name: 'Master', depth: 3, noise: 0, nodes: 500_000 },
};

export function strengthOf(id: unknown): Strength {
  if (typeof id === 'string' && Object.hasOwn(STRENGTHS, id)) return STRENGTHS[id];
  return STRENGTHS.adept;
}

/** 0..1, how central a square is. Board-size agnostic, so 6x6 works too. */
function centrality(v: Variant, s: number): number {
  const cf = (v.w - 1) / 2;
  const cr = (v.h - 1) / 2;
  const df = Math.abs(fileOf(v, s) - cf) / (cf || 1);
  const dr = Math.abs(rankOf(v, s) - cr) / (cr || 1);
  return 1 - (df + dr) / 2;
}

function pieceSquare(v: Variant, type: number, s: number, color: Color): number {
  const c = centrality(v, s);
  switch (type) {
    case PAWN: {
      const r = rankOf(v, s);
      const progress = color === 1 ? r / (v.h - 1) : (v.h - 1 - r) / (v.h - 1);
      return Math.round(60 * progress * progress + 8 * c);
    }
    case KNIGHT:
      return Math.round(34 * c);
    case BISHOP:
      return Math.round(26 * c);
    case ROOK:
      return Math.round(10 * c);
    case QUEEN:
      return Math.round(8 * c);
    case KING:
      return Math.round(-18 * c);
    default:
      return 0;
  }
}

/** Static evaluation from WHITE's point of view. */
export function evaluate(v: Variant, p: Position): number {
  let score = 0;
  for (let i = 0; i < p.b.length; i++) {
    const pc = p.b[i];
    if (pc === 0) continue;
    const color = (pc > 0 ? 1 : -1) as Color;
    const type = Math.abs(pc);
    score += color * (VALUE[type] + pieceSquare(v, type, i, color));
  }
  return score;
}

/** Material only, used by the balance sim to decide who is "leading". */
export function material(p: Position): number {
  let score = 0;
  for (let i = 0; i < p.b.length; i++) {
    const pc = p.b[i];
    if (pc === 0) continue;
    score += (pc > 0 ? 1 : -1) * VALUE[Math.abs(pc)];
  }
  return score;
}

const isCapture = (p: Position, m: Move): boolean =>
  p.b[moveTo(m)] !== 0 || moveFlag(m) === FLAG_EP;

/**
 * How good does this capture look, before searching?
 *
 * Ordinary chess uses MVV-LVA ("take the biggest thing with the smallest
 * piece") purely as a heuristic. Under the morph it is closer to literal truth:
 * you gain the captured piece off the board AND your own piece is replaced by
 * one of that type, so the material swing is roughly
 *
 *     value(captured) + (value(captured) - value(mover)) = 2*cap - mover
 *
 * which is why taking a pawn with a queen (2*100 - 900 = -700) sorts to the
 * very bottom, exactly where a Changeling player would put it.
 */
function captureGain(p: Position, m: Move): number {
  const flag = moveFlag(m);
  const cap = flag === FLAG_EP ? PAWN : Math.abs(p.b[moveTo(m)]);
  if (cap === 0) return 0;
  const mover = Math.abs(p.b[m & 0x7f]);
  if (mover === KING || flag === FLAG_KEEP) return VALUE[cap];
  return 2 * VALUE[cap] - VALUE[mover];
}

function scoreMove(p: Position, m: Move): number {
  let s = captureGain(p, m) * 8;
  const promo = movePromo(m);
  if (promo) s += VALUE[promo];
  return s;
}

function sortMoves(p: Position, moves: Move[]): Move[] {
  const scored = moves.map((m) => ({ m, s: scoreMove(p, m) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.m);
}

interface Ctx {
  v: Variant;
  nodes: number;
  limit: number;
}

function quiesce(ctx: Ctx, p: Position, alpha: number, beta: number, depth: number): number {
  const us = p.turn;
  const stand = evaluate(ctx.v, p) * us;
  if (depth <= 0 || ctx.nodes > ctx.limit) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  const moves = sortMoves(
    p,
    genPseudo(ctx.v, p).filter((m) => isCapture(p, m)),
  );
  for (const m of moves) {
    ctx.nodes++;
    const u = makeMove(ctx.v, p, m);
    if (attacked(ctx.v, p, kingSquare(p, us), -us as Color)) {
      unmakeMove(ctx.v, p, u);
      continue;
    }
    const score = -quiesce(ctx, p, -beta, -alpha, depth - 1);
    unmakeMove(ctx.v, p, u);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

/**
 * Evaluation with all pending captures resolved, from WHITE's point of view.
 *
 * Raw material is a LIAR in Changeling and the balance sim proved it: capturing
 * first hands the recapturer both your (freshly upgraded) piece and an upgrade of
 * their own, so the raw material reading mid-exchange systematically favours the
 * side who is about to be punished for it. Resolving the captures first is what
 * makes "who is ahead" a real question rather than a measure of whose turn it is.
 */
export function quietEval(v: Variant, p: Position): number {
  const ctx: Ctx = { v, nodes: 0, limit: 40_000 };
  return quiesce(ctx, p, -Infinity, Infinity, 6) * p.turn;
}

function search(ctx: Ctx, p: Position, depth: number, alpha: number, beta: number, ply: number): number {
  if (ctx.nodes > ctx.limit) return evaluate(ctx.v, p) * p.turn;
  if (p.half >= 100) return 0;
  if (depth <= 0) return quiesce(ctx, p, alpha, beta, 4);

  const us = p.turn;
  const moves = sortMoves(p, genPseudo(ctx.v, p));
  let legal = 0;
  for (const m of moves) {
    ctx.nodes++;
    const u = makeMove(ctx.v, p, m);
    if (attacked(ctx.v, p, kingSquare(p, us), -us as Color)) {
      unmakeMove(ctx.v, p, u);
      continue;
    }
    legal++;
    const score = -search(ctx, p, depth - 1, -beta, -alpha, ply + 1);
    unmakeMove(ctx.v, p, u);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  if (legal === 0) {
    return attacked(ctx.v, p, kingSquare(p, us), -us as Color) ? -MATE + ply : 0;
  }
  return alpha;
}

export interface Choice {
  move: Move;
  score: number;
  nodes: number;
}

/**
 * Pick a move. `rng` is required rather than optional so a bot is always
 * reproducible: the balance sim seeds it, and the solo game seeds it per game.
 */
export function chooseMove(
  v: Variant,
  p: Position,
  strength: Strength,
  rng: Rng,
): Choice | null {
  const ctx: Ctx = { v, nodes: 0, limit: strength.nodes };
  const us = p.turn;
  const moves = sortMoves(p, genPseudo(v, p));
  let best: Move | null = null;
  let bestScore = -Infinity;
  let alpha = -Infinity;
  for (const m of moves) {
    const u = makeMove(v, p, m);
    if (attacked(v, p, kingSquare(p, us), -us as Color)) {
      unmakeMove(v, p, u);
      continue;
    }
    ctx.nodes++;
    // With noise on, every root move gets a FULL window: an alpha cutoff returns
    // a bound rather than a true score, and a bound plus jitter is not a
    // comparable number — the "weaker" bots would pick moves for arithmetic
    // reasons rather than random ones, which is not the same thing at all.
    const raw =
      strength.noise > 0
        ? -search(ctx, p, strength.depth - 1, -Infinity, Infinity, 1)
        : -search(ctx, p, strength.depth - 1, -Infinity, -alpha, 1);
    unmakeMove(v, p, u);
    const score = strength.noise > 0 ? raw + Math.round((rng() * 2 - 1) * strength.noise) : raw;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
    if (raw > alpha) alpha = raw;
  }
  return best === null ? null : { move: best, score: bestScore, nodes: ctx.nodes };
}
