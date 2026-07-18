/**
 * modes.ts — the three shapes a Changeling round can take.
 *
 * A mode must change how the game PLAYS, not just a number:
 *   Classic   — the full 8x8 game with castling. Openings matter.
 *   Skirmish  — 6x6, no castling, no double-step. A knife fight where a single
 *               capture is a big fraction of the board and promotion is close.
 *   Wildcourt — 8x8 with a seeded, MIRRORED shuffle of the back rank. No opening
 *               theory survives; both sides get the identical arrangement, so
 *               the opening is fair by construction rather than by tuning.
 *
 * The HOST's pick is what the room plays. It travels frozen inside the round
 * start (rematch.ts `roundOpts`), so a guest never reads its own local UI
 * selection and calls it the host's — a mode that changes the BOARD SIZE would
 * otherwise have two peers playing different games on the same seed.
 */

import type { Variant } from './chess';
import { makeRng, shuffle } from './engine/rng';

export interface Mode {
  id: string;
  name: string;
  /** One line, shown on the mode picker. */
  blurb: string;
  variant: Variant;
  /** Starting clock per player, ms. */
  clockMs: number;
  /** Added to a player's clock after each of their moves, ms. */
  incrementMs: number;
  /** Back rank is shuffled from the round seed (identical for both sides). */
  shuffled: boolean;
}

const STANDARD_BACK = 'RNBQKBNR';
const SKIRMISH_BACK = 'RNBQKR';

export const MODES: Record<string, Mode> = {
  classic: {
    id: 'classic',
    name: 'Classic',
    blurb: '8x8, full chess rules with castling. 10 min + 5s.',
    variant: { w: 8, h: 8, backRank: STANDARD_BACK, doubleStep: true, castling: true, morph: 'forced' },
    clockMs: 10 * 60_000,
    incrementMs: 5_000,
    shuffled: false,
  },
  skirmish: {
    id: 'skirmish',
    name: 'Skirmish',
    blurb: '6x6, 12 pieces a side, pawns walk. Fast and brutal. 3 min + 3s.',
    variant: { w: 6, h: 6, backRank: SKIRMISH_BACK, doubleStep: false, castling: false, morph: 'forced' },
    clockMs: 3 * 60_000,
    incrementMs: 3_000,
    shuffled: false,
  },
  wildcourt: {
    id: 'wildcourt',
    name: 'Wildcourt',
    blurb: '8x8, back rank shuffled the same way for both sides. No theory. 8 min + 5s.',
    variant: { w: 8, h: 8, backRank: STANDARD_BACK, doubleStep: true, castling: false, morph: 'forced' },
    clockMs: 8 * 60_000,
    incrementMs: 5_000,
    shuffled: true,
  },
};

export const MODE_IDS = Object.keys(MODES);
export const DEFAULT_MODE = 'classic';

/**
 * Validate a mode id that may have come off the wire. `MODES[id] || DEFAULT`
 * would happily let 'constructor' or 'toString' through as a Mode of undefined
 * fields, so untrusted keys go through Object.hasOwn.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return MODES[DEFAULT_MODE];
}

/**
 * The back rank this round actually starts from. Wildcourt shuffles it from the
 * shared round seed so every peer derives the identical arrangement without any
 * board state crossing the wire, and BOTH colours use the same string, so the
 * opening position is mirror-symmetric and no seat can draw a better board.
 */
export function backRankFor(mode: Mode, seed: number): string {
  if (!mode.shuffled) return mode.variant.backRank;
  return shuffle(makeRng(seed), mode.variant.backRank.split('')).join('');
}

/** The variant for a round, with the seeded back rank baked in. */
export function variantFor(mode: Mode, seed: number): Variant {
  return { ...mode.variant, backRank: backRankFor(mode, seed) };
}
