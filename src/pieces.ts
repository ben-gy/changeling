// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * pieces.ts — the six silhouettes, as procedural inline SVG.
 *
 * Not Unicode chess glyphs: those are drawn by whatever font the device happens
 * to have, so the same board renders as thin outlines on one phone and colour
 * emoji on another, and half of them have no black/white distinction at all.
 * Hand-authored paths also mean the morph can CROSS-FADE between two shapes,
 * which is the single most important animation in the game.
 *
 * All paths live in a 100x100 box, stand on the same baseline and share a base
 * width, so a piece swapping type reads as the same object changing rather than
 * one object being replaced by another.
 */

import { BISHOP, KING, KNIGHT, PAWN, QUEEN, ROOK } from './chess';

const BASE = 'M24 78 H76 L80 90 H20 Z';

const PATHS: Record<number, string[]> = {
  [PAWN]: [
    'M50 20 a13 13 0 1 1 -0.1 0 Z',
    'M39 44 Q50 57 61 44 L67 78 H33 Z',
    BASE,
  ],
  [KNIGHT]: [
    'M63 17 C49 15 39 23 33 33 L25 44 C21 50 25 57 31 55 L40 51 C38 60 36 70 34 78 H70 C75 58 77 31 63 17 Z',
    'M57 30 a3.5 3.5 0 1 1 -0.1 0 Z',
    BASE,
  ],
  [BISHOP]: [
    'M50 8 a5 5 0 1 1 -0.1 0 Z',
    'M50 16 C61 27 69 38 69 48 C69 59 61 66 50 66 C39 66 31 59 31 48 C31 38 39 27 50 16 Z',
    'M35 66 H65 L68 78 H32 Z',
    BASE,
  ],
  [ROOK]: [
    'M27 15 H38 V24 H45 V15 H55 V24 H62 V15 H73 V34 H27 Z',
    'M34 34 H66 L70 78 H30 Z',
    BASE,
  ],
  [QUEEN]: [
    'M26 22 a5 5 0 1 1 -0.1 0 Z',
    'M42 19 a5 5 0 1 1 -0.1 0 Z',
    'M58 19 a5 5 0 1 1 -0.1 0 Z',
    'M74 22 a5 5 0 1 1 -0.1 0 Z',
    'M26 26 L34 48 L42 24 L50 48 L58 24 L66 48 L74 26 L70 66 H30 Z',
    'M31 66 H69 L72 78 H28 Z',
    BASE,
  ],
  [KING]: [
    'M46 4 H54 V12 H62 V20 H54 V29 H46 V20 H38 V12 H46 Z',
    'M31 34 C31 28 40 24 50 24 C60 24 69 28 69 34 L70 66 H30 Z',
    'M31 66 H69 L72 78 H28 Z',
    BASE,
  ],
};

export const PIECE_NAME: Record<number, string> = {
  [PAWN]: 'pawn',
  [KNIGHT]: 'knight',
  [BISHOP]: 'bishop',
  [ROOK]: 'rook',
  [QUEEN]: 'queen',
  [KING]: 'king',
};

/** SVG markup for one piece type. `title` gives it an accessible name. */
export function pieceSvg(type: number, title?: string): string {
  const paths = PATHS[type] ?? PATHS[PAWN];
  const label = title ? `<title>${title}</title>` : '';
  return (
    `<svg viewBox="0 0 100 100" aria-hidden="${title ? 'false' : 'true'}" focusable="false">` +
    label +
    paths.map((d) => `<path d="${d}" />`).join('') +
    '</svg>'
  );
}

export function pieceLabel(pc: number): string {
  if (pc === 0) return 'empty';
  return `${pc > 0 ? 'white' : 'black'} ${PIECE_NAME[Math.abs(pc)] ?? 'piece'}`;
}
