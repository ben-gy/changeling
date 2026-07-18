/**
 * board.test.ts — the input stream and the animation reset.
 *
 * jsdom has no layout engine, so the board's rect is stubbed. That limits what
 * can be tested here to LOGIC (which square did that pointer hit, did a drag
 * become a move, did the piece settle) — the visual half is covered by looking
 * at every mode in a real browser at phone width, which is the only place an
 * overflow or an overlap ever shows up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoard, type BoardState, type BoardView } from '../src/board';
import { findMove, genLegal, initialPosition, makeMove, sq } from '../src/chess';
import { MODES } from '../src/modes';

const V = MODES.classic.variant;
const SIZE = 400;
const CELL = SIZE / 8;

let root: HTMLElement;
let view: BoardView;
let moves: Array<[number, number]>;

function stubRect(el: HTMLElement): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: SIZE, height: SIZE, right: SIZE, bottom: SIZE, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

/** Centre of a square in client coords, for the default (white at bottom) view. */
function centre(file: number, rank: number): [number, number] {
  return [(file + 0.5) * CELL, (8 - rank - 0.5) * CELL];
}

function pointer(el: HTMLElement, type: string, x: number, y: number): void {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent & {
    clientX: number;
    clientY: number;
    pointerId: number;
  };
  Object.assign(ev, { clientX: x, clientY: y, pointerId: 1 });
  el.dispatchEvent(ev);
}

function state(over: Partial<BoardState> = {}): BoardState {
  const pos = initialPosition(V);
  return {
    pos,
    legal: genLegal(V, pos),
    interactive: true,
    flipped: false,
    lastMove: null,
    checkSq: null,
    ...over,
  };
}

/** The position after 1.e4, so an animation hint has a piece to animate. */
function afterE4(): BoardState {
  const pos = initialPosition(V);
  const m = findMove(V, pos, sq(V, 4, 1), sq(V, 4, 3)) as number;
  makeMove(V, pos, m);
  return {
    pos,
    legal: [],
    interactive: false,
    flipped: false,
    lastMove: { from: sq(V, 4, 1), to: sq(V, 4, 3) },
    checkSq: null,
  };
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  moves = [];
  view = createBoard({
    root,
    variant: V,
    onMove: (from, to) => {
      moves.push([from, to]);
      return true;
    },
  });
  stubRect(view.el);
});

afterEach(() => {
  view.destroy();
  root.remove();
  vi.restoreAllMocks();
});

describe('board input', () => {
  it('renders a square and a piece for every one on the board', () => {
    view.render(state());
    expect(view.el.querySelectorAll('.sq')).toHaveLength(64);
    expect(view.el.querySelectorAll('.pc')).toHaveLength(32);
  });

  it('plays a move as tap-to-select then tap-to-move', () => {
    view.render(state());
    const [fx, fy] = centre(4, 1); // e2
    const [tx, ty] = centre(4, 3); // e4
    pointer(view.el, 'pointerdown', fx, fy);
    pointer(view.el, 'pointerup', fx, fy);
    pointer(view.el, 'pointerdown', tx, ty);
    pointer(view.el, 'pointerup', tx, ty);
    expect(moves).toEqual([[sq(V, 4, 1), sq(V, 4, 3)]]);
  });

  it('plays a move as a drag, preserving tap as a first-class action', () => {
    view.render(state());
    const [fx, fy] = centre(4, 1);
    const [tx, ty] = centre(4, 3);
    pointer(view.el, 'pointerdown', fx, fy);
    pointer(view.el, 'pointermove', fx, fy - 20); // past the 8px drag slop
    pointer(view.el, 'pointermove', tx, ty);
    pointer(view.el, 'pointerup', tx, ty);
    expect(moves).toEqual([[sq(V, 4, 1), sq(V, 4, 3)]]);
  });

  it('treats pointercancel as an aborted gesture, not a move', () => {
    view.render(state());
    const [fx, fy] = centre(4, 1);
    pointer(view.el, 'pointerdown', fx, fy);
    pointer(view.el, 'pointermove', fx, fy - 40);
    pointer(view.el, 'pointercancel', fx, fy - 40);
    expect(moves).toEqual([]);
  });

  it('ignores input when it is not the player’s turn', () => {
    view.render(state({ interactive: false, legal: [] }));
    const [fx, fy] = centre(4, 1);
    pointer(view.el, 'pointerdown', fx, fy);
    pointer(view.el, 'pointerup', fx, fy);
    expect(moves).toEqual([]);
  });

  it('drops input from an unmeasurable board instead of computing NaN squares', () => {
    // A 0-size rect means the board is not laid out yet. Dividing by it yields
    // NaN co-ordinates, which silently address square NaN.
    view.render(state());
    view.el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    pointer(view.el, 'pointerdown', 10, 10);
    pointer(view.el, 'pointerup', 10, 10);
    expect(moves).toEqual([]);
  });

  it('maps squares correctly when the board is flipped for Black', () => {
    view.render(state({ flipped: true }));
    // Flipped, e2 sits where a mirrored point lands.
    const [x, y] = [(8 - 4 - 0.5) * CELL, (1 + 0.5) * CELL];
    pointer(view.el, 'pointerdown', x, y);
    pointer(view.el, 'pointerup', x, y);
    const [tx, ty] = [(8 - 4 - 0.5) * CELL, (3 + 0.5) * CELL];
    pointer(view.el, 'pointerdown', tx, ty);
    pointer(view.el, 'pointerup', tx, ty);
    expect(moves).toEqual([[sq(V, 4, 1), sq(V, 4, 3)]]);
  });

  it('shows legal destinations as dots and captures as rings', () => {
    view.render(state());
    const [fx, fy] = centre(1, 0); // b1 knight
    pointer(view.el, 'pointerdown', fx, fy);
    pointer(view.el, 'pointerup', fx, fy);
    expect(view.el.querySelectorAll('.sq.target').length).toBeGreaterThan(0);
    // Nothing is capturable from the opening position.
    expect(view.el.querySelectorAll('.sq.capture')).toHaveLength(0);
  });
});

describe('the slide animation settles even in a tab that never paints', () => {
  it('releases the piece on a timer when requestAnimationFrame never fires', () => {
    // A backgrounded tab does not run rAF at all. The piece is rendered one cell
    // BEHIND its square and released on the next frame, so a rAF that never
    // arrives leaves it visually stranded off its own square. Found in a real
    // browser; this is the guard.
    vi.useFakeTimers();
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafs.push(cb);
      return 1;
    });

    view.render(afterE4(), { from: sq(V, 4, 1), to: sq(V, 4, 3) });
    const piece = view.el.querySelector('.pc[data-i="28"]') as HTMLElement;
    expect(piece).toBeTruthy();
    expect(piece.style.getPropertyValue('--dx')).not.toBe('');

    vi.advanceTimersByTime(100);

    expect(rafs.length, 'the frame was requested but never ran').toBe(1);
    expect(piece.style.getPropertyValue('--dx')).toBe('');
    expect(piece.style.getPropertyValue('--dy')).toBe('');
    expect(piece.classList.contains('sliding')).toBe(false);
    vi.useRealTimers();
  });

  it('does not double-release when both the frame and the timer arrive', () => {
    vi.useFakeTimers();
    const rafs: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafs.push(cb);
      return 1;
    });
    view.render(afterE4(), { from: sq(V, 4, 1), to: sq(V, 4, 3), morphed: true });
    const piece = view.el.querySelector('.pc[data-i="28"]') as HTMLElement;
    rafs[0](0);
    vi.advanceTimersByTime(100);
    expect(piece.classList.contains('morphed')).toBe(true);
    expect(piece.style.getPropertyValue('--dx')).toBe('');
    vi.useRealTimers();
  });
});
