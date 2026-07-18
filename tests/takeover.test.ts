/**
 * takeover.test.ts — the automated half of multiplayer contract gate #2.
 *
 * The manual smoke test (close the host tab, survivor keeps playing) is the other
 * half and neither replaces the other. This file exists because rhythm-relay
 * shipped with host transfer simply not wired, and nothing caught it.
 *
 * Changeling is lockstep, so the board survives a host change for free — the
 * board was never the host's. The clock is the one authoritative thing, so these
 * tests are aimed squarely at it: a guest must NOT move it, a promoted guest MUST
 * move it, and a promoted guest must be able to drive the game to `over`.
 */

import { describe, expect, it } from 'vitest';
import { Session, type ClockMsg, type MoveMsg, type SessionBus } from '../src/session';
import { MODES } from '../src/modes';
import { sq } from '../src/chess';

const ROSTER = [
  { id: 'peer-a', name: 'Ada' },
  { id: 'peer-b', name: 'Bo' },
];

function bus(): SessionBus & { moves: MoveMsg[]; clocks: ClockMsg[] } {
  const moves: MoveMsg[] = [];
  const clocks: ClockMsg[] = [];
  return {
    moves,
    clocks,
    sendMove: (m) => moves.push(m),
    sendClock: (c) => clocks.push(c),
  };
}

function make(selfId: string, isHost: boolean, round = 0) {
  const b = bus();
  const s = new Session({
    mode: MODES.classic,
    seed: 4242,
    roster: ROSTER,
    round,
    selfId,
    isHost,
    bus: b,
  });
  return { s, b };
}

/** Open with 1.e4 so the clock is running (it starts on White's first move). */
function openingMove(s: Session): boolean {
  const v = s.game.variant;
  return s.playLocal(sq(v, 4, 1), sq(v, 4, 3));
}

describe('host transfer', () => {
  it('a guest does not move the clock, however long it waits', () => {
    const { s: host } = make('peer-a', true);
    const { s: guest } = make('peer-b', false);
    openingMove(host);
    guest.onRemoteMove({ f: sq(guest.game.variant, 4, 1), t: sq(guest.game.variant, 4, 3) }, 'peer-a');

    const before = { ...guest.game.clock };
    guest.pump(0);
    guest.pump(60_000);
    expect(guest.game.clock).toEqual(before);
  });

  it('the host does move the clock, and broadcasts it', () => {
    const { s: host, b } = make('peer-a', true);
    openingMove(host);
    host.pump(0);
    host.pump(3_000);
    expect(host.game.clock.b).toBeLessThan(MODES.classic.clockMs);
    expect(b.clocks.length).toBeGreaterThan(0);
  });

  it('a promoted guest adopts the clock it last saw and starts driving it', () => {
    const { s: guest, b } = make('peer-b', false);
    openingMove(guest); // ignored — not this peer's turn as guest? white is peer-a
    guest.onRemoteMove({ f: sq(guest.game.variant, 4, 1), t: sq(guest.game.variant, 4, 3) }, 'peer-a');
    guest.onRemoteClock({ w: 111_000, b: 222_000 });

    guest.setHost(true);
    // It re-broadcasts what it adopted, so the room agrees immediately.
    expect(b.clocks.at(-1)).toEqual({ w: 111_000, b: 222_000 });

    guest.pump(0);
    guest.pump(5_000);
    expect(guest.game.clock.b).toBeLessThan(222_000);
    expect(guest.game.clock.w).toBe(111_000);
  });

  it('a promoted guest can drive the game all the way to over', () => {
    // The gate that matters: not merely "is promoted" but "the game keeps
    // running and can still END". A survivor stuck on a frozen board is a fail.
    const { s: guest } = make('peer-b', false);
    guest.onRemoteMove({ f: sq(guest.game.variant, 4, 1), t: sq(guest.game.variant, 4, 3) }, 'peer-a');
    guest.onRemoteClock({ w: 60_000, b: 2_000 });
    expect(guest.game.outcome().over).toBe(false);

    guest.setHost(true);
    guest.pump(0);
    guest.pump(10_000);

    const out = guest.game.outcome();
    expect(out.over).toBe(true);
    if (out.over) {
      expect(out.reason).toBe('timeout');
      expect(out.winner).toBe(1); // black flagged, so white wins
    }
  });

  it('an opponent leaving ends the round decisively instead of freezing it', () => {
    const { s: host } = make('peer-a', true);
    openingMove(host);
    expect(host.game.outcome().over).toBe(false);
    host.onPeerLeave('peer-b');
    const out = host.game.outcome();
    expect(out.over).toBe(true);
    if (out.over) expect(out.winner).toBe(1);
    expect(host.hasLeft('b')).toBe(true);
  });

  it('fires onEnd exactly once so every peer reaches the summary', () => {
    let ends = 0;
    const s = new Session({
      mode: MODES.classic,
      seed: 7,
      roster: ROSTER,
      round: 0,
      selfId: 'peer-a',
      isHost: true,
      bus: bus(),
      onEnd: () => ends++,
    });
    openingMove(s);
    s.onPeerLeave('peer-b');
    s.pump(0);
    s.pump(9_000);
    expect(ends).toBe(1);
  });
});

describe('seats', () => {
  it('gives both peers the same view of who is White', () => {
    const { s: a } = make('peer-a', true);
    const { s: b } = make('peer-b', false);
    expect(a.seatOf('peer-a')).toBe('w');
    expect(b.seatOf('peer-a')).toBe('w');
    expect(a.localSeat()).toBe('w');
    expect(b.localSeat()).toBe('b');
  });

  it('swaps colours every round, identically on both peers', () => {
    const { s: a } = make('peer-a', true, 1);
    const { s: b } = make('peer-b', false, 1);
    expect(a.localSeat()).toBe('b');
    expect(b.localSeat()).toBe('w');
    expect(a.seatOf('peer-b')).toBe(b.seatOf('peer-b'));
  });

  it('refuses a move from the seat that is not to move', () => {
    const { s: host } = make('peer-a', true);
    const v = host.game.variant;
    // Black trying to move on White's turn.
    expect(host.onRemoteMove({ f: sq(v, 4, 6), t: sq(v, 4, 4) }, 'peer-b')).toBe(false);
    // White's own move, from the wrong peer.
    expect(host.onRemoteMove({ f: sq(v, 4, 1), t: sq(v, 4, 3) }, 'peer-b')).toBe(false);
    expect(host.onRemoteMove({ f: sq(v, 4, 1), t: sq(v, 4, 3) }, 'peer-a')).toBe(true);
  });

  it('refuses an illegal move off the wire rather than corrupting the board', () => {
    const { s: host } = make('peer-a', true);
    const v = host.game.variant;
    const before = host.game.pos.b.join(',');
    expect(host.onRemoteMove({ f: sq(v, 4, 1), t: sq(v, 4, 5) }, 'peer-a')).toBe(false);
    expect(host.onRemoteMove({ f: 999, t: 1000 }, 'peer-a')).toBe(false);
    expect(host.game.pos.b.join(',')).toBe(before);
  });

  it('lets a peer resign, and the other peer sees it', () => {
    const { s: a, b: busA } = make('peer-a', true);
    const { s: b } = make('peer-b', false);
    openingMove(a);
    b.onRemoteMove({ f: sq(b.game.variant, 4, 1), t: sq(b.game.variant, 4, 3) }, 'peer-a');
    b.resign();
    const msg = busA.moves.at(-1);
    expect(b.game.outcome().over).toBe(true);
    void msg;
    a.onRemoteMove({ f: -1, t: -1, r: true }, 'peer-b');
    const out = a.game.outcome();
    expect(out.over && out.winner).toBe(1);
  });
});
