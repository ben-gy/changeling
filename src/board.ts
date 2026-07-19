/**
 * board.ts — the board view and every way a player can touch it.
 *
 * Two input schemes over ONE Pointer Events stream, which is what
 * patterns/MOBILE_CONTROLS.md asks for on a board game: tap-to-select then
 * tap-to-move stays a first-class action, and the same press can instead be
 * dragged or flicked to the destination. `classifyRelease` from the shared
 * gesture classifier makes that decision, so the thresholds are the verified
 * ones rather than a fresh guess.
 *
 * Pieces are placed with CSS GRID, never with pixel transforms, and the slide
 * animation is expressed in percentages of the piece's own size — one cell is
 * exactly 100%. That is deliberate: a transform-positioned DOM board measures
 * itself, and a tab that is backgrounded when the round starts measures 0 and
 * piles every piece into the corner. This board never measures anything to
 * decide where a piece goes, so it cannot have that bug.
 */

import {
  FLAG_KEEP,
  fileOf,
  moveFlag,
  moveFrom,
  movePromo,
  moveTo,
  rankOf,
  type Move,
  type Position,
  type Variant,
} from './chess';
import { classifyRelease } from '@ben-gy/game-engine/drag';
import { pieceLabel, pieceSvg } from './pieces';

const THRESHOLDS = { tapSlop: 3, swipeDist: 50, swipeVel: 0.5, swipeMaxMs: 250 };
/** Press-to-drag promotion distance, px (MOBILE_CONTROLS §2). */
const DRAG_SLOP = 8;

export interface BoardState {
  pos: Position;
  /** Legal moves for the side to move — [] when it is not the player's turn. */
  legal: Move[];
  interactive: boolean;
  flipped: boolean;
  lastMove: { from: number; to: number } | null;
  /** Square of a king in check, to pulse. */
  checkSq: number | null;
}

export interface BoardOptions {
  root: HTMLElement;
  variant: Variant;
  /** Ask the owner to play a move. Return false to reject (e.g. not your turn). */
  onMove: (from: number, to: number, promo: number, keep: boolean) => boolean;
  onSelect?: (sq: number | null) => void;
  reducedMotion?: boolean;
}

export interface AnimHint {
  from: number;
  to: number;
  /** Set when the moving piece changed type — triggers the morph flourish. */
  morphed?: boolean;
}

export interface BoardView {
  render(state: BoardState, anim?: AnimHint): void;
  clearSelection(): void;
  destroy(): void;
  readonly el: HTMLElement;
}

export function createBoard(o: BoardOptions): BoardView {
  const v = o.variant;
  const el = document.createElement('div');
  el.className = 'board';
  el.style.setProperty('--files', String(v.w));
  el.style.setProperty('--ranks', String(v.h));
  el.setAttribute('role', 'grid');
  el.setAttribute('aria-label', 'game board');
  o.root.appendChild(el);

  let state: BoardState | null = null;
  let selected: number | null = null;

  // Squares are built once and never rebuilt — only the pieces churn.
  const squares: HTMLElement[] = [];
  for (let i = 0; i < v.w * v.h; i++) {
    const s = document.createElement('div');
    s.className = `sq ${(fileOf(v, i) + rankOf(v, i)) % 2 === 0 ? 'dark' : 'light'}`;
    s.dataset.i = String(i);
    el.appendChild(s);
    squares.push(s);
  }

  const layer = document.createElement('div');
  layer.className = 'pieces';
  el.appendChild(layer);

  function place(node: HTMLElement, i: number): void {
    const flipped = state?.flipped ?? false;
    const col = (flipped ? v.w - 1 - fileOf(v, i) : fileOf(v, i)) + 1;
    const row = (flipped ? rankOf(v, i) : v.h - 1 - rankOf(v, i)) + 1;
    node.style.gridColumn = String(col);
    node.style.gridRow = String(row);
  }

  function positionSquares(): void {
    for (let i = 0; i < squares.length; i++) place(squares[i], i);
  }

  /** Which square is under a client point, or null (also null if unmeasurable). */
  function squareAt(clientX: number, clientY: number): number | null {
    const rect = el.getBoundingClientRect();
    // A 0-size rect means the board is not laid out yet (hidden tab, mid-transition).
    // Deriving a cell from it would give NaN, so drop the input instead.
    if (rect.width < 1 || rect.height < 1) return null;
    const fx = Math.floor(((clientX - rect.left) / rect.width) * v.w);
    const fy = Math.floor(((clientY - rect.top) / rect.height) * v.h);
    if (fx < 0 || fx >= v.w || fy < 0 || fy >= v.h) return null;
    const flipped = state?.flipped ?? false;
    const file = flipped ? v.w - 1 - fx : fx;
    const rank = flipped ? fy : v.h - 1 - fy;
    return rank * v.w + file;
  }

  const movesFrom = (from: number): Move[] =>
    (state?.legal ?? []).filter((m) => moveFrom(m) === from);

  const movesBetween = (from: number, to: number): Move[] =>
    (state?.legal ?? []).filter((m) => moveFrom(m) === from && moveTo(m) === to);

  function setSelected(next: number | null): void {
    selected = next;
    o.onSelect?.(next);
    paint();
  }

  /** Ask for a move, opening a chooser when the destination is ambiguous. */
  function requestMove(from: number, to: number): void {
    const options = movesBetween(from, to);
    if (options.length === 0) return;
    if (options.length === 1) {
      if (o.onMove(from, to, movePromo(options[0]), moveFlag(options[0]) === FLAG_KEEP)) {
        setSelected(null);
      }
      return;
    }
    openChooser(from, to, options);
  }

  let chooser: HTMLElement | null = null;

  function closeChooser(): void {
    chooser?.remove();
    chooser = null;
  }

  function openChooser(from: number, to: number, options: Move[]): void {
    closeChooser();
    const box = document.createElement('div');
    box.className = 'chooser';
    const keeps = options.some((m) => moveFlag(m) === FLAG_KEEP);
    box.innerHTML =
      `<p class="ch-title">${keeps ? 'Take its shape, or keep yours?' : 'Promote to'}</p>` +
      `<div class="ch-row">${options
        .map((m, idx) => {
          const promo = movePromo(m);
          const keep = moveFlag(m) === FLAG_KEEP;
          const type = promo || 0;
          const label = keep ? 'Keep' : promo ? 'Promote' : 'Take shape';
          return (
            `<button class="ch-opt" data-idx="${idx}" type="button">` +
            (type ? `<span class="ch-pc">${pieceSvg(type)}</span>` : '') +
            `<span class="ch-lab">${label}</span></button>`
          );
        })
        .join('')}</div>`;
    box.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('.ch-opt') as HTMLElement | null;
      if (!btn) return;
      const m = options[Number(btn.dataset.idx)];
      closeChooser();
      if (o.onMove(from, to, movePromo(m), moveFlag(m) === FLAG_KEEP)) setSelected(null);
    });
    o.root.appendChild(box);
    chooser = box;
  }

  // ── pointer handling ──────────────────────────────────────────────────────
  let pointerId: number | null = null;
  let downSq: number | null = null;
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let dragging = false;
  let dragEl: HTMLElement | null = null;

  function ownPieceAt(i: number): boolean {
    return movesFrom(i).length > 0;
  }

  function endDrag(): void {
    if (dragEl) {
      dragEl.classList.remove('dragging');
      dragEl.style.removeProperty('--dragx');
      dragEl.style.removeProperty('--dragy');
    }
    dragEl = null;
    dragging = false;
    pointerId = null;
    downSq = null;
  }

  function onDown(ev: PointerEvent): void {
    if (!state?.interactive || chooser) return;
    const i = squareAt(ev.clientX, ev.clientY);
    if (i === null) return;
    pointerId = ev.pointerId;
    downSq = i;
    downX = ev.clientX;
    downY = ev.clientY;
    downT = performance.now();
    dragging = false;
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is a nicety, not a requirement */
    }
    if (ownPieceAt(i)) setSelected(i);
  }

  function onMoveEv(ev: PointerEvent): void {
    if (pointerId !== ev.pointerId || downSq === null) return;
    const dx = ev.clientX - downX;
    const dy = ev.clientY - downY;
    if (!dragging && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!dragging) {
      if (!ownPieceAt(downSq)) return;
      dragging = true;
      dragEl = layer.querySelector(`.pc[data-i="${downSq}"]`);
      dragEl?.classList.add('dragging');
    }
    if (dragEl) {
      // Follow the finger exactly — a piece that lags its own drag feels broken,
      // and the grab offset is preserved because the delta is from the press.
      dragEl.style.setProperty('--dragx', `${dx}px`);
      dragEl.style.setProperty('--dragy', `${dy}px`);
    }
    ev.preventDefault();
  }

  function onUp(ev: PointerEvent): void {
    if (pointerId !== ev.pointerId || downSq === null) return endDrag();
    const from = downSq;
    const g = classifyRelease(
      ev.clientX - downX,
      ev.clientY - downY,
      performance.now() - downT,
      dragging,
      THRESHOLDS,
    );
    const over = squareAt(ev.clientX, ev.clientY);
    endDrag();
    paint();

    if (g.kind === 'tap') {
      // Tap: either this is the pick-up, or it is the put-down of a piece that
      // was already selected.
      if (selected !== null && selected !== from) requestMove(selected, from);
      else if (!ownPieceAt(from)) setSelected(null);
      return;
    }
    // A drag or a flick lands the piece wherever it was released.
    if (over !== null && over !== from) requestMove(from, over);
    else setSelected(null);
  }

  function onCancel(ev: PointerEvent): void {
    if (pointerId !== ev.pointerId) return;
    // An aborted gesture is not a move. Treat it as putting the piece back.
    endDrag();
    paint();
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMoveEv);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);

  // ── painting ──────────────────────────────────────────────────────────────

  function paint(anim?: AnimHint): void {
    if (!state) return;
    positionSquares();
    const { pos } = state;

    const targets = new Set(selected === null ? [] : movesFrom(selected).map(moveTo));
    for (let i = 0; i < squares.length; i++) {
      const s = squares[i];
      s.classList.toggle('sel', selected === i);
      s.classList.toggle('last', state.lastMove !== null && (state.lastMove.from === i || state.lastMove.to === i));
      s.classList.toggle('check', state.checkSq === i);
      const isTarget = targets.has(i);
      s.classList.toggle('target', isTarget && pos.b[i] === 0);
      // A capture gets a RING and an empty square a DOT, so the two states are
      // distinguishable without relying on colour at all.
      s.classList.toggle('capture', isTarget && pos.b[i] !== 0);
    }

    layer.textContent = '';
    for (let i = 0; i < pos.b.length; i++) {
      const pc = pos.b[i];
      if (pc === 0) continue;
      const node = document.createElement('div');
      node.className = `pc ${pc > 0 ? 'w' : 'b'}`;
      node.dataset.i = String(i);
      node.dataset.type = String(Math.abs(pc));
      node.setAttribute('aria-label', pieceLabel(pc));
      node.innerHTML = pieceSvg(Math.abs(pc));
      place(node, i);
      layer.appendChild(node);
    }

    if (anim && !o.reducedMotion) {
      const node = layer.querySelector(`.pc[data-i="${anim.to}"]`) as HTMLElement | null;
      if (node) {
        const flipped = state.flipped;
        const dxCells =
          (fileOf(v, anim.to) - fileOf(v, anim.from)) * (flipped ? -1 : 1);
        const dyCells =
          (rankOf(v, anim.to) - rankOf(v, anim.from)) * (flipped ? 1 : -1);
        // Percentages of the piece's OWN size: one cell is exactly 100%, so this
        // needs no measurement and cannot be thrown off by a 0-size layout.
        node.style.setProperty('--dx', String(-dxCells));
        node.style.setProperty('--dy', String(-dyCells));
        node.classList.add('sliding');
        // The piece starts one cell BEHIND where it belongs and is released on
        // the next frame, so it slides into place. Releasing it is therefore
        // correctness, not decoration — and a backgrounded tab never fires a
        // rAF, which would strand the piece a cell off its own square until the
        // player looked at it again. So a timer backs the frame up, and
        // whichever arrives first wins.
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          node.classList.remove('sliding');
          node.style.removeProperty('--dx');
          node.style.removeProperty('--dy');
          if (anim.morphed) node.classList.add('morphed');
        };
        requestAnimationFrame(release);
        setTimeout(release, 32);
      }
    } else if (anim?.morphed) {
      const node = layer.querySelector(`.pc[data-i="${anim.to}"]`) as HTMLElement | null;
      node?.classList.add('morphed');
    }
  }

  return {
    el,
    render(next, anim) {
      state = next;
      if (!next.interactive) selected = null;
      closeChooser();
      paint(anim);
    },
    clearSelection() {
      setSelected(null);
      closeChooser();
    },
    destroy() {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMoveEv);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      closeChooser();
      el.remove();
    },
  };
}
