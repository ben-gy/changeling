/**
 * mobile.test.ts — the phone hardening, which is invisible until it is missing.
 *
 * Every assertion here stands for a way a real player has lost, or could lose, a
 * live round on a phone:
 *
 *   --vh      a 100vh layout is cut off by the collapsing URL bar. But a tab that
 *             reports innerHeight 0 must NOT be believed — writing 0px through
 *             collapses every calc(var(--vh) * 100) to a blank page.
 *   gesture*  <meta name="viewport" user-scalable=no> is IGNORED by iOS Safari.
 *             Cancelling the proprietary gesture events is the only defence
 *             against a pinch-zoomed board with no way back out.
 *   touchend  a fast second tap zooms on iOS even with touch-action set.
 *   unharden  listeners on `document` outlive any screen that installed them.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hardenViewport, type Unharden } from '../src/engine/mobile';

/** Fire a cancelable event and report whether something refused it. */
function fire(target: EventTarget, type: string): boolean {
  const e = new Event(type, { cancelable: true, bubbles: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

function setInnerHeight(h: number): void {
  Object.defineProperty(window, 'innerHeight', {
    value: h,
    configurable: true,
    writable: true,
  });
}

let unharden: Unharden | undefined;
const realHeight = window.innerHeight;

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.style.removeProperty('--vh');
  setInnerHeight(realHeight || 768);
});

afterEach(() => {
  unharden?.();
  unharden = undefined;
  vi.useRealTimers();
  document.documentElement.style.removeProperty('--vh');
  setInnerHeight(realHeight || 768);
});

describe('hardenViewport — the --vh unit', () => {
  it('writes --vh as one hundredth of the real viewport height', () => {
    setInnerHeight(640);
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6.4px');
  });

  it('re-measures on resize', () => {
    setInnerHeight(640);
    unharden = hardenViewport();
    setInnerHeight(800);
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('8px');
  });

  it('re-measures on orientationchange and visibilitychange', () => {
    setInnerHeight(640);
    unharden = hardenViewport();

    setInnerHeight(900);
    window.dispatchEvent(new Event('orientationchange'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('9px');

    // The first real measurement may only arrive once the tab is shown.
    setInnerHeight(500);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('5px');
  });

  it('REFUSES a 0 innerHeight — 0px would collapse the page to blank', () => {
    // A backgrounded or pre-rendered tab reports 0. Believing it sets --vh: 0px,
    // which makes every `min-height: calc(var(--vh) * 100)` zero and renders a
    // blank page. The 1vh fallback in mobile.css must survive instead.
    setInnerHeight(0);
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
  });

  it('does not clobber a good --vh when a later measure reports 0', () => {
    setInnerHeight(640);
    unharden = hardenViewport();
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6.4px');

    setInnerHeight(0);
    window.dispatchEvent(new Event('resize'));
    // The last known-good height stands.
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('6.4px');
  });

  it('can be switched off', () => {
    setInnerHeight(640);
    unharden = hardenViewport({ vhUnit: false });
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
  });
});

describe('hardenViewport — pinch zoom', () => {
  it('refuses gesturestart and gesturechange', () => {
    unharden = hardenViewport();
    // Safari-only events, and the only way to refuse a pinch: the viewport meta
    // is ignored by iOS.
    expect(fire(document, 'gesturestart')).toBe(true);
    expect(fire(document, 'gesturechange')).toBe(true);
  });

  it('refuses gestureend too, so the zoom cannot settle', () => {
    unharden = hardenViewport();
    expect(fire(document, 'gestureend')).toBe(true);
  });

  it('leaves gestures alone when switched off', () => {
    unharden = hardenViewport({ pinch: false });
    expect(fire(document, 'gesturestart')).toBe(false);
  });
});

describe('hardenViewport — double-tap zoom', () => {
  it('refuses a second touchend inside the 320ms window', () => {
    unharden = hardenViewport();
    expect(fire(document, 'touchend')).toBe(false); // the first tap is a real tap
    vi.advanceTimersByTime(100);
    expect(fire(document, 'touchend')).toBe(true); // the second would zoom
  });

  it('allows a slow second touchend — two deliberate taps are two taps', () => {
    unharden = hardenViewport();
    expect(fire(document, 'touchend')).toBe(false);
    vi.advanceTimersByTime(400);
    expect(fire(document, 'touchend')).toBe(false);
  });

  it('refuses dblclick', () => {
    unharden = hardenViewport();
    expect(fire(document, 'dblclick')).toBe(true);
  });

  it('leaves taps alone when switched off', () => {
    unharden = hardenViewport({ doubleTap: false });
    expect(fire(document, 'touchend')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(fire(document, 'touchend')).toBe(false);
  });
});

describe('hardenViewport — teardown', () => {
  it('removes every listener it installed', () => {
    const off = hardenViewport();
    expect(fire(document, 'gesturestart')).toBe(true);

    off();

    expect(fire(document, 'gesturestart')).toBe(false);
    expect(fire(document, 'gesturechange')).toBe(false);
    expect(fire(document, 'dblclick')).toBe(false);
    expect(fire(document, 'touchend')).toBe(false);
    vi.advanceTimersByTime(50);
    expect(fire(document, 'touchend')).toBe(false);

    // And --vh stops tracking the viewport.
    document.documentElement.style.removeProperty('--vh');
    setInnerHeight(700);
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--vh')).toBe('');
  });
});

describe('the [hidden] rule', () => {
  // A class that sets `display` on the same element silently defeats the UA rule
  // in Safari, leaving an invisible blur/dim layer on top that eats every tap.
  // This has shipped once. Both sheets must assert it — mobile.css because it is
  // the baseline, main.css because it is the sheet loaded LAST and therefore the
  // one a game rule would otherwise beat.
  const hiddenRule = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/;

  it.each([
    ['src/engine/mobile.css'],
    ['src/styles/main.css'],
  ])('%s forces display:none on [hidden]', (path) => {
    expect(readFileSync(path, 'utf8')).toMatch(hiddenRule);
  });
});

describe('the board fits ANY board size (principle #20)', () => {
  // Driftlock's 9x9 shipped completely broken while its 5x5 was flawless, because
  // every gate played the default mode once. jsdom has no layout engine so it
  // cannot see an overflow itself — but the CSS invariants that PREVENT one are
  // pinnable, and reverting any of them is what re-arms it. Changeling has two
  // board sizes (8x8 and 6x6) and both must survive a 375px phone.
  const css = readFileSync('src/styles/main.css', 'utf8');

  it('sizes both axes with minmax(0, 1fr) so any board can shrink to fit', () => {
    // A bare `1fr` is minmax(auto, 1fr), which lets content floor a track and
    // pushes the far columns off a narrow screen.
    expect(css).toMatch(/grid-template-columns:\s*repeat\(var\(--files\),\s*minmax\(0,\s*1fr\)\)/);
    expect(css).toMatch(/grid-template-rows:\s*repeat\(var\(--ranks\),\s*minmax\(0,\s*1fr\)\)/);
  });

  it('drives the board box from the variant, never from a fixed size', () => {
    expect(css).toMatch(/aspect-ratio:\s*var\(--files\)\s*\/\s*var\(--ranks\)/);
    // min(100%, ...) is what stops a tall board being sized by height alone and
    // spilling sideways out of the viewport.
    expect(css).toMatch(/\.board\s*\{[^}]*max-width:\s*min\(100%/);
  });

  it('moves pieces in PERCENTAGES of their own cell, never in measured pixels', () => {
    // The hidden-tab reflow bug: a transform-positioned DOM board measures
    // itself, and a tab backgrounded at round start measures 0 and piles every
    // piece into the corner. One cell is exactly 100% of a piece, so this board
    // never measures anything to decide where a piece goes.
    expect(css).toMatch(
      /\.pc\s*\{[^}]*transform:\s*translate\(calc\(var\(--dx,\s*0\)\s*\*\s*100%\),\s*calc\(var\(--dy,\s*0\)\s*\*\s*100%\)\)/,
    );
  });

  it('hides the site footer mid-round so it never steals play area', () => {
    const mobile = readFileSync('src/engine/mobile.css', 'utf8');
    expect(`${css}${mobile}`).toMatch(/body\.playing\s+\.site-footer\s*\{[^}]*display:\s*none/);
  });
});
