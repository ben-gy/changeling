// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * session.ts — the multiplayer round, with no DOM and no Trystero in sight.
 *
 * Changeling is LOCKSTEP, not a snapshot star, and that is a deliberate choice
 * rather than a shortcut: there is zero randomness in play and zero hidden
 * information, so a peer only ever broadcasts {from, to, promo} and both sides
 * apply the identical forced morph to identical boards. The board therefore
 * cannot desync — there is nothing to desync.
 *
 * That leaves exactly ONE piece of host-authoritative state: the clock. Which is
 * what makes host transfer real work rather than a formality — the promoted peer
 * adopts the last clock it saw as canonical, resumes ticking, and becomes the
 * only peer allowed to call flag-fall. tests/takeover.test.ts proves a guest
 * does not move the clock and that a promoted one can drive a game to over.
 */

import { Game } from './game';
import { findMove } from './chess';
import type { Mode } from './modes';

export type Seat = 'w' | 'b';

export interface SeatedPlayer {
  id: string;
  name: string;
  seat: Seat;
}

/** Wire message: a move. Kept to four short keys — it is sent every turn. */
export interface MoveMsg {
  f: number;
  t: number;
  p?: number;
  k?: boolean;
  /** Not a move at all — the sender resigned. */
  r?: boolean;
}

/** Wire message: the host's clock. */
export interface ClockMsg {
  w: number;
  b: number;
}

export interface SessionBus {
  sendMove(msg: MoveMsg): void;
  sendClock(msg: ClockMsg): void;
}

export interface SessionConfig {
  mode: Mode;
  seed: number;
  /** Frozen roster from rematch.ts, in the host's order. */
  roster: Array<{ id: string; name: string }>;
  /** Round number — colours swap every round so White is never the same twice. */
  round: number;
  selfId: string;
  isHost: boolean;
  bus: SessionBus;
  onUpdate?: (reason: 'move' | 'clock' | 'roster') => void;
  onEnd?: () => void;
}

const noop = (): void => {};

export class Session {
  readonly game: Game;
  readonly players: SeatedPlayer[];
  private selfId: string;
  private host: boolean;
  private bus: SessionBus;
  private onUpdate: (reason: 'move' | 'clock' | 'roster') => void;
  private onEnd: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTick = 0;
  private sinceBroadcast = 0;
  private ended = false;
  /** Seats whose player has left the room. */
  private gone = new Set<Seat>();

  constructor(config: SessionConfig) {
    this.game = new Game(config.mode, config.seed);
    this.selfId = config.selfId;
    this.host = config.isHost;
    this.bus = config.bus;
    this.onUpdate = config.onUpdate ?? noop;
    this.onEnd = config.onEnd ?? noop;

    // Colours swap on odd rounds. Both peers derive this from the SAME frozen
    // roster and the SAME round number, so they always agree who is White
    // without a negotiation.
    const [first, second] = config.roster;
    const flip = config.round % 2 === 1;
    this.players = [
      first ? { ...first, seat: (flip ? 'b' : 'w') as Seat } : null,
      second ? { ...second, seat: (flip ? 'w' : 'b') as Seat } : null,
    ].filter(Boolean) as SeatedPlayer[];
  }

  /** Which seat this peer plays, or null when it is a spectator. */
  localSeat(): Seat | null {
    return this.players.find((p) => p.id === this.selfId)?.seat ?? null;
  }

  seatOf(id: string): Seat | null {
    return this.players.find((p) => p.id === id)?.seat ?? null;
  }

  playerAt(seat: Seat): SeatedPlayer | null {
    return this.players.find((p) => p.seat === seat) ?? null;
  }

  isHost(): boolean {
    return this.host;
  }

  /** The seat to move right now. */
  turnSeat(): Seat {
    return this.game.turn === 1 ? 'w' : 'b';
  }

  isLocalTurn(): boolean {
    const seat = this.localSeat();
    return seat !== null && seat === this.turnSeat() && !this.game.outcome().over;
  }

  start(): void {
    this.lastTick = Date.now();
    if (this.timer) return;
    // setInterval, never rAF: a backgrounded host tab must keep the clock honest
    // or a player tabbing away silently freezes their opponent's game.
    this.timer = setInterval(() => this.pump(), 250);
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Advance wall-clock time. Split out from the interval so tests can drive it
   * deterministically. A GUEST deliberately does nothing here — the clock is the
   * host's, and a guest that ticked it would be a second authority.
   */
  pump(nowMs = Date.now()): void {
    const elapsed = Math.max(0, nowMs - this.lastTick);
    this.lastTick = nowMs;
    if (!this.host || this.ended) return;
    if (this.game.outcome().over) return this.checkEnd();
    if (this.game.played.length === 0) return; // clock starts on White's first move

    this.game.tick(elapsed);
    this.sinceBroadcast += elapsed;
    if (this.sinceBroadcast >= 1000) {
      this.sinceBroadcast = 0;
      this.bus.sendClock({ w: this.game.clock.w, b: this.game.clock.b });
    }
    this.onUpdate('clock');
    this.checkEnd();
  }

  /** Host promotion. The whole of host transfer for this game lives here. */
  setHost(isHost: boolean): void {
    if (this.host === isHost) return;
    this.host = isHost;
    if (isHost) {
      // Adopt whatever clock we last heard as canonical and take over ticking.
      // Nothing else needs adopting: the board was never the host's to own.
      this.lastTick = Date.now();
      this.sinceBroadcast = 0;
      this.bus.sendClock({ w: this.game.clock.w, b: this.game.clock.b });
    }
    this.onUpdate('roster');
  }

  /** A peer left the room. A seated player leaving ends the round decisively. */
  onPeerLeave(id: string): void {
    const seat = this.seatOf(id);
    if (!seat) return;
    this.gone.add(seat);
    if (!this.game.outcome().over) {
      this.game.end(seat === 'w' ? -1 : 1, 'resign');
    }
    this.onUpdate('roster');
    this.checkEnd();
  }

  hasLeft(seat: Seat): boolean {
    return this.gone.has(seat);
  }

  /** Play a move the local player made. Returns false if it was not legal. */
  playLocal(from: number, to: number, promo = 0, keep = false): boolean {
    if (!this.isLocalTurn()) return false;
    const m = findMove(this.game.variant, this.game.pos, from, to, promo, keep);
    if (m === null) return false;
    if (!this.game.play(m)) return false;
    this.bus.sendMove({ f: from, t: to, ...(promo ? { p: promo } : {}), ...(keep ? { k: true } : {}) });
    this.afterMove();
    return true;
  }

  /** Apply a move that arrived from a peer. */
  onRemoteMove(msg: MoveMsg, from: string): boolean {
    const senderSeat = this.seatOf(from);
    if (msg.r === true) {
      if (!senderSeat || this.game.outcome().over) return false;
      this.game.end(senderSeat === 'w' ? -1 : 1, 'resign');
      this.onUpdate('move');
      this.checkEnd();
      return true;
    }
    // The sender must own the seat that is actually to move. This is the whole
    // of anti-cheat for a lockstep game: an out-of-turn or foreign-seat move is
    // simply not applied, and because both peers run the same generator they
    // reject the same things.
    if (senderSeat !== this.turnSeat()) return false;
    if (this.game.outcome().over) return false;
    const m = findMove(this.game.variant, this.game.pos, msg.f, msg.t, msg.p ?? 0, msg.k === true);
    if (m === null) return false;
    if (!this.game.play(m)) return false;
    this.afterMove();
    return true;
  }

  /** Apply a clock from the host. Guests never compute their own. */
  onRemoteClock(msg: ClockMsg): void {
    if (this.host) return;
    if (typeof msg.w !== 'number' || typeof msg.b !== 'number') return;
    this.game.clock.w = Math.max(0, msg.w);
    this.game.clock.b = Math.max(0, msg.b);
    this.onUpdate('clock');
  }

  /** Resign the local seat. */
  resign(): void {
    const seat = this.localSeat();
    if (!seat || this.game.outcome().over) return;
    this.game.end(seat === 'w' ? -1 : 1, 'resign');
    this.bus.sendMove({ f: -1, t: -1, r: true });
    this.onUpdate('move');
    this.checkEnd();
  }

  private afterMove(): void {
    this.lastTick = Date.now();
    this.onUpdate('move');
    this.checkEnd();
  }

  private checkEnd(): void {
    if (this.ended) return;
    if (!this.game.outcome().over) return;
    this.ended = true;
    this.destroy();
    this.onEnd();
  }
}
