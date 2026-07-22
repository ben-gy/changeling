// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * game.ts — a whole game of Changeling: position + history + clocks + the
 * per-player record the results screen is built from.
 *
 * Deliberately pure of DOM and of network. The P2P layer only ever hands it
 * {from, to, promo} and it re-derives everything else, which is why two peers
 * cannot drift: there is no randomness in play and no hidden information, so the
 * same move applied to the same position gives the same board on both sides.
 */

import {
  FLAG_EP,
  FLAG_KEEP,
  KING,
  PAWN,
  QUEEN,
  genLegal,
  initialPosition,
  makeMove,
  moveFlag,
  moveFrom,
  moveText,
  moveTo,
  outcomeOf,
  positionKey,
  resultType,
  promoRank,
  rankOf,
  movePromo,
  type Color,
  type Move,
  type Outcome,
  type Position,
  type Variant,
} from './chess';
import { VALUE } from './ai';
import { variantFor, type Mode } from './modes';

export interface PlayedMove {
  move: Move;
  /** Readable text including the morph, e.g. "Qxe5=P". */
  text: string;
  by: Color;
  /** Type the piece was before the move. */
  wasType: number;
  /** Type it ended up as. */
  nowType: number;
  /** Type captured, or 0. */
  tookType: number;
  /** Material swing for the mover, in centipawns. */
  swing: number;
}

export interface PlayerRecord {
  captures: number;
  /** Captures that made the capturing piece BIGGER. */
  upgrades: number;
  /** Captures that made it smaller — the signature cost of greed. */
  downgrades: number;
  /** Best single morph, by material swing. */
  bestMorph: { text: string; swing: number } | null;
  /** The juiciest capture that was available and declined — "what you missed". */
  bestMissed: { text: string; swing: number; ply: number } | null;
  /** Material at the end, from this player's point of view. */
  material: number;
}

function emptyRecord(): PlayerRecord {
  return {
    captures: 0,
    upgrades: 0,
    downgrades: 0,
    bestMorph: null,
    bestMissed: null,
    material: 0,
  };
}

/**
 * Material swing of a move for the side making it: the captured piece leaves the
 * board AND the capturing piece is replaced by one of that type. Both halves
 * matter, and the second half is what makes a queen-takes-pawn a disaster.
 */
export function moveSwing(v: Variant, p: Position, m: Move): number {
  const from = moveFrom(m);
  const to = moveTo(m);
  const flag = moveFlag(m);
  const moverType = Math.abs(p.b[from]);
  const capType = flag === FLAG_EP ? PAWN : Math.abs(p.b[to]);
  if (capType === 0 && !movePromo(m)) return 0;
  const color = (p.b[from] > 0 ? 1 : -1) as Color;
  let end = resultType(moverType, capType, flag === FLAG_KEEP);
  if (end === PAWN && rankOf(v, to) === promoRank(v, color)) end = movePromo(m) || QUEEN;
  return VALUE[capType] + (VALUE[end] - VALUE[moverType]);
}

export class Game {
  readonly variant: Variant;
  readonly mode: Mode;
  readonly seed: number;
  pos: Position;
  readonly played: PlayedMove[] = [];
  readonly records: Record<'w' | 'b', PlayerRecord> = { w: emptyRecord(), b: emptyRecord() };
  /** ms remaining per side. */
  clock: Record<'w' | 'b', number>;
  private repetition = new Map<string, number>();
  private finished: Outcome = { over: false };

  constructor(mode: Mode, seed: number) {
    this.mode = mode;
    this.seed = seed;
    this.variant = variantFor(mode, seed);
    this.pos = initialPosition(this.variant);
    this.clock = { w: mode.clockMs, b: mode.clockMs };
    this.bump();
  }

  private bump(): void {
    const k = positionKey(this.pos);
    this.repetition.set(k, (this.repetition.get(k) ?? 0) + 1);
  }

  get turn(): Color {
    return this.pos.turn;
  }

  legal(): Move[] {
    return genLegal(this.variant, this.pos);
  }

  outcome(): Outcome {
    if (this.finished.over) return this.finished;
    return outcomeOf(this.variant, this.pos, this.repetition);
  }

  /** End the game for a reason the rules cannot see (clock, resignation). */
  end(winner: 0 | 1 | -1, reason: 'timeout' | 'resign'): void {
    if (!this.finished.over) this.finished = { over: true, winner, reason };
  }

  /** Apply a legal move. Returns the record of what happened, or null if illegal. */
  play(m: Move): PlayedMove | null {
    if (this.finished.over) return null;
    if (!this.legal().includes(m)) return null;

    const v = this.variant;
    const p = this.pos;
    const by = p.turn;
    const key: 'w' | 'b' = by === 1 ? 'w' : 'b';
    const rec = this.records[key];

    // "What you missed": the best capture that was on the board this turn. Only
    // meaningful against what was actually played, so it is measured here, at
    // the moment of the decision, and never reconstructed afterwards.
    let bestAvailable: { text: string; swing: number } | null = null;
    for (const cand of this.legal()) {
      const s = moveSwing(v, p, cand);
      if (s > (bestAvailable?.swing ?? 0)) bestAvailable = { text: moveText(v, p, cand), swing: s };
    }

    const from = moveFrom(m);
    const to = moveTo(m);
    const flag = moveFlag(m);
    const wasType = Math.abs(p.b[from]);
    const tookType = flag === FLAG_EP ? PAWN : Math.abs(p.b[to]);
    const swing = moveSwing(v, p, m);
    const text = moveText(v, p, m);

    makeMove(v, p, m);
    const nowType = Math.abs(p.b[to]);
    this.bump();

    const entry: PlayedMove = { move: m, text, by, wasType, nowType, tookType, swing };
    this.played.push(entry);

    if (tookType !== 0) {
      rec.captures++;
      if (wasType !== KING) {
        if (nowType > wasType) rec.upgrades++;
        else if (nowType < wasType) rec.downgrades++;
      }
      if (!rec.bestMorph || swing > rec.bestMorph.swing) rec.bestMorph = { text, swing };
    }
    if (bestAvailable && bestAvailable.swing > swing + 100) {
      if (!rec.bestMissed || bestAvailable.swing > rec.bestMissed.swing) {
        rec.bestMissed = { ...bestAvailable, ply: this.played.length };
      }
    }

    this.clock[key] += this.mode.incrementMs;
    return entry;
  }

  /** Charge elapsed thinking time to the side to move. Host-authoritative. */
  tick(ms: number): void {
    const key: 'w' | 'b' = this.pos.turn === 1 ? 'w' : 'b';
    this.clock[key] = Math.max(0, this.clock[key] - ms);
    if (this.clock[key] === 0) this.end(this.pos.turn === 1 ? -1 : 1, 'timeout');
  }

  /** Final per-player breakdown — BOTH players, always (principle #9). */
  summary(): { w: PlayerRecord; b: PlayerRecord; outcome: Outcome; plies: number } {
    const mat = materialOf(this.pos);
    this.records.w.material = mat;
    this.records.b.material = -mat;
    return { w: this.records.w, b: this.records.b, outcome: this.outcome(), plies: this.played.length };
  }
}

function materialOf(p: Position): number {
  let s = 0;
  for (let i = 0; i < p.b.length; i++) {
    const pc = p.b[i];
    if (pc !== 0) s += (pc > 0 ? 1 : -1) * VALUE[Math.abs(pc)];
  }
  return s;
}
