/**
 * main.ts — screens, wiring, and the one Net that lives for a whole session.
 *
 * The room rule that outranks everything else: this file joins a Trystero room
 * ONCE and holds it until the player walks back to the menu. Every rematch
 * happens inside that room via rematch.ts. There is no code path here that
 * leaves a room and rejoins the same one.
 */

// feedback:begin (managed by hub/scripts/feedback/backfill.mjs)
import { mountFeedback } from './feedback';
mountFeedback();
// feedback:end

import './engine/mobile.css';
import './styles/main.css';

import { chooseMove, quietEval, strengthOf, STRENGTHS, type Strength } from './ai';
import { createBoard, type AnimHint, type BoardView } from './board';
import { inCheck, kingSquare, moveFrom, movePromo, moveTo } from './chess';
import { createCountdown, type Countdown } from './countdown';
import { createNet, type Net } from './engine/net';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  normalizeRoomCode,
  setRoomInUrl,
} from './engine/lobby';
import { resolveName } from './engine/identity';
import { hardenViewport } from './engine/mobile';
import { createRounds, type RoundInfo, type Rounds } from './engine/rematch';
import { makeRng, newSeed } from './engine/rng';
import { createSfx } from './engine/sound';
import { createStore } from './engine/storage';
import { DEFAULT_MODE, MODES, MODE_IDS, modeOf, type Mode } from './modes';
import { pieceSvg } from './pieces';
import { Session, type Seat } from './session';

const app = document.getElementById('app') as HTMLElement;
const store = createStore('changeling');
const sfx = createSfx(store.get('muted', false));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const AI_ID = '~ai';
const SELF_ID = '~you';

let mode: Mode = modeOf(store.get('mode', DEFAULT_MODE));
let strength: Strength = strengthOf(store.get('ai', 'adept'));
let playerName = 'You';

// ── session-scoped state ────────────────────────────────────────────────────
let net: Net | null = null;
let rounds: Rounds | null = null;
let roomCode = '';
let session: Session | null = null;
let board: BoardView | null = null;
let countdown: Countdown | null = null;
let aiTimer: ReturnType<typeof setTimeout> | undefined;
let hudTimer: ReturnType<typeof setInterval> | undefined;
let soloRng = makeRng(1);
const tally = { w: 0, l: 0, d: 0 };
let armed = false; // false while the countdown is still running
/** Plies already given the sound-and-flourish treatment. */
let animatedPly = 0;
/** Guards the once-per-round bookkeeping on the results screen. */
let resultsShown = false;
let bus = {
  sendMove: (_m: unknown) => {},
  sendClock: (_c: unknown) => {},
};

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);

function setPlaying(on: boolean): void {
  document.body.classList.toggle('playing', on);
}

function clearScreen(): void {
  countdown?.cancel();
  countdown = null;
  if (aiTimer) clearTimeout(aiTimer);
  aiTimer = undefined;
  if (hudTimer) clearInterval(hudTimer);
  hudTimer = undefined;
  board?.destroy();
  board = null;
  app.textContent = '';
}

function screen(html: string): HTMLElement {
  clearScreen();
  const wrap = document.createElement('div');
  wrap.className = 'screen';
  wrap.innerHTML = html;
  app.appendChild(wrap);
  return wrap;
}

const FOOTER = `<footer class="site-footer">Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a></footer>`;

// ── menu ────────────────────────────────────────────────────────────────────

function modePicker(selected: string, name = 'mode'): string {
  return `<div class="modes" role="radiogroup" aria-label="Mode">${MODE_IDS.map((id) => {
    const m = MODES[id];
    return `<button type="button" class="mode-opt${id === selected ? ' on' : ''}" role="radio" aria-checked="${id === selected}" data-${name}="${id}">
      <span class="mo-name">${esc(m.name)}</span>
      <span class="mo-blurb">${esc(m.blurb)}</span>
    </button>`;
  }).join('')}</div>`;
}

function showMenu(): void {
  setPlaying(false);
  const wrap = screen(`
    <main class="main-content menu">
      <h1 class="title"><span class="t-was">${pieceSvg(5)}</span><span class="t-arrow">→</span><span class="t-now">${pieceSvg(1)}</span></h1>
      <p class="wordmark">Changeling</p>
      <p class="tagline">Chess, but a capture turns your piece into what it took.</p>
      ${modePicker(mode.id)}
      <div class="row">
        <label class="field"><span>Opponent</span>
          <select id="ai-strength">${Object.values(STRENGTHS)
            .map((s) => `<option value="${s.id}"${s.id === strength.id ? ' selected' : ''}>${esc(s.name)}</option>`)
            .join('')}</select>
        </label>
        <label class="field"><span>You play</span>
          <select id="side"><option value="w">White</option><option value="b">Black</option><option value="r">Random</option></select>
        </label>
      </div>
      <button class="btn primary big" id="play">Play</button>
      <button class="btn" id="friends">Play with a friend</button>
      <div class="row small">
        <button class="btn ghost" id="howto">How to play</button>
        <button class="btn ghost" id="about">About</button>
        <button class="btn ghost" id="mute">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
      </div>
    </main>
    ${FOOTER}
  `);

  wrap.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      mode = modeOf((b as HTMLElement).dataset.mode);
      store.set('mode', mode.id);
      sfx.play('select');
      showMenu();
    }),
  );
  wrap.querySelector('#ai-strength')?.addEventListener('change', (e) => {
    strength = strengthOf((e.target as HTMLSelectElement).value);
    store.set('ai', strength.id);
  });
  wrap.querySelector('#play')?.addEventListener('click', () => {
    sfx.unlock();
    sfx.play('select');
    const pick = (wrap.querySelector('#side') as HTMLSelectElement).value;
    const asWhite = pick === 'r' ? Math.random() < 0.5 : pick === 'w';
    startSolo(asWhite);
  });
  wrap.querySelector('#friends')?.addEventListener('click', () => {
    sfx.unlock();
    sfx.play('select');
    showRoomEntry();
  });
  wrap.querySelector('#howto')?.addEventListener('click', () => showHowTo());
  wrap.querySelector('#about')?.addEventListener('click', showAbout);
  wrap.querySelector('#mute')?.addEventListener('click', (e) => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    (e.target as HTMLElement).textContent = sfx.muted() ? 'Sound off' : 'Sound on';
  });

  if (!store.get('seenHowTo', false)) showHowTo();
}

// ── modals ──────────────────────────────────────────────────────────────────

function modal(title: string, body: string): void {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <h2>${esc(title)}</h2>${body}
    <button class="btn primary" data-close type="button">Got it</button>
  </div>`;
  const close = (): void => back.remove();
  back.addEventListener('click', (e) => {
    if (e.target === back || (e.target as HTMLElement).hasAttribute('data-close')) close();
  });
  app.appendChild(back);
}

function showHowTo(): void {
  store.set('seenHowTo', true);
  modal(
    'How to play',
    `<p>It's chess. All the normal rules, win by checkmate.</p>
     <p class="lead"><strong>One change: when your piece captures, it turns into whatever it just captured.</strong></p>
     <p>Take a pawn with your queen and your queen <em>becomes a pawn</em>. Ram a pawn into their queen and that pawn <em>becomes a queen</em>. Only the king is immune — it captures and stays royal.</p>
     <p>So the piece you most want to capture with is usually your worst one, and whoever recaptures last comes out holding the good shape.</p>
     <p class="hint">Tap a piece to see its moves, then tap where to go — or just drag it there.</p>`,
  );
}

function showAbout(): void {
  modal(
    'About',
    `<p><strong>Changeling</strong> is chess with a single extra rule: a capturing piece takes the shape of what it captured.</p>
     <p>No accounts, no cookies, no tracking. Page views are counted anonymously with Cloudflare Web Analytics, and that is the only analytics here.</p>
     <p>Playing with a friend is <strong>peer-to-peer</strong>: your browsers talk directly to each other over WebRTC. A free public signalling relay only brokers the initial handshake — no game data touches a server of ours, because there isn't one.</p>
     <p>Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>. <a href="https://hub.benrichardson.dev" target="_blank" rel="noopener">More games, tools &amp; sites</a>.</p>`,
  );
}

// ── solo ────────────────────────────────────────────────────────────────────

function startSolo(asWhite: boolean): void {
  const seed = newSeed();
  soloRng = makeRng(seed);
  const roster = asWhite
    ? [{ id: SELF_ID, name: playerName }, { id: AI_ID, name: strength.name }]
    : [{ id: AI_ID, name: strength.name }, { id: SELF_ID, name: playerName }];
  session = new Session({
    mode,
    seed,
    roster,
    round: 0,
    selfId: SELF_ID,
    isHost: true,
    bus: { sendMove: () => {}, sendClock: () => {} },
    onUpdate: onSessionUpdate,
    onEnd: () => showResults(),
  });
  armed = true;
  animatedPly = 0;
  resultsShown = false;
  session.start();
  renderGame(undefined, true);
  maybeMoveAi();
}

/**
 * The single place a change to the round reaches the screen — local move, peer
 * move, AI reply and resignation all arrive here, so the juice cannot end up
 * wired to only one of them.
 */
function onSessionUpdate(reason: 'move' | 'clock' | 'roster'): void {
  if (reason === 'clock') return paintHud();
  const played = session?.game.played.length ?? 0;
  if (reason === 'move' && played > animatedPly) {
    animatedPly = played;
    celebrateMove();
    return;
  }
  renderGame();
}

function maybeMoveAi(): void {
  const s = session;
  if (!s || !armed) return;
  if (s.game.outcome().over) return;
  if (s.playerAt(s.turnSeat())?.id !== AI_ID) return;
  if (aiTimer) clearTimeout(aiTimer);
  // A beat before the reply, so a move does not feel like it was pre-computed,
  // and so the player sees their own piece land first.
  aiTimer = setTimeout(() => {
    if (!session || session.game.outcome().over) return;
    const choice = chooseMove(session.game.variant, session.game.pos, strength, soloRng);
    if (!choice) return;
    session.onRemoteMove(
      { f: moveFrom(choice.move), t: moveTo(choice.move), p: movePromo(choice.move) },
      AI_ID,
    );
  }, 420);
}

// ── multiplayer ─────────────────────────────────────────────────────────────

function showRoomEntry(): void {
  setPlaying(false);
  const wrap = screen(`<main class="main-content"><div id="entry"></div></main>${FOOTER}`);
  const host = wrap.querySelector('#entry') as HTMLElement;
  createRoomEntry({
    container: host,
    title: 'Play with a friend',
    subtitle: 'Start a room and share the code, or type a friend’s code to join.',
    onSubmit: (code, created) => enterRoom(normalizeRoomCode(code), created),
    onCancel: () => showMenu(),
  });
}

/** Join the room ONCE. Everything after this happens inside it. */
function enterRoom(code: string, created: boolean): void {
  roomCode = code;
  setRoomInUrl(code);
  // A tally belongs to a match, and a match belongs to a room.
  tally.w = 0;
  tally.l = 0;
  tally.d = 0;
  net = createNet(
    { appId: 'changeling', roomId: code, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        session?.setHost(isSelfHost);
        if (session) renderGame();
      },
      onPeerLeave: (id) => {
        session?.onPeerLeave(id);
        if (session) renderGame();
      },
      onPeers: () => {
        if (session) renderGame();
      },
    },
  );

  const sendMove = net.channel<Record<string, number | boolean>>('mv', (data, from) => {
    session?.onRemoteMove(data as never, from);
  });
  const sendClock = net.channel<{ w: number; b: number }>('clk', (data) => {
    session?.onRemoteClock(data);
    paintHud();
  });
  bus = {
    sendMove: (m) => sendMove(m as never),
    sendClock: (c) => sendClock(c as { w: number; b: number }),
  };

  rounds = createRounds({
    net,
    playerName,
    minPlayers: 2,
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => startNetRound(info),
    onChange: () => {
      // The results screen shows live rematch state (who is ready, the
      // countdown), so it repaints in place. It must NOT be rebuilt, or the
      // match tally would be counted again on every vote.
      const host = document.getElementById('res-actions');
      if (host) paintRematch(host);
    },
  });

  showLobby();
}

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  setPlaying(false);
  const wrap = screen(`
    <main class="main-content">
      <div class="lobby-mode" id="lobby-mode"></div>
      <div id="lobby"></div>
    </main>${FOOTER}`);

  const modeHost = wrap.querySelector('#lobby-mode') as HTMLElement;
  const paintMode = (): void => {
    const iAmHost = net?.isHost() === true && net.hostSettled();
    if (iAmHost) {
      modeHost.innerHTML = `<p class="lm-title">Mode — your pick is what the room plays</p>${modePicker(mode.id, 'lmode')}`;
      modeHost.querySelectorAll('[data-lmode]').forEach((b) =>
        b.addEventListener('click', () => {
          mode = modeOf((b as HTMLElement).dataset.lmode);
          store.set('mode', mode.id);
          sfx.play('select');
          paintMode();
        }),
      );
    } else {
      // The HOST's choice, gossiped — never this peer's own local selection
      // dressed up as the host's, which would be a confident lie.
      const opts = rounds?.state().hostOpts as { mode?: string } | undefined;
      const hostMode = opts?.mode ? modeOf(opts.mode) : null;
      modeHost.innerHTML = hostMode
        ? `<p class="lm-title">Host picked</p><div class="lm-host"><strong>${esc(hostMode.name)}</strong><span>${esc(hostMode.blurb)}</span></div>`
        : `<p class="lm-title">Waiting for the host to pick a mode…</p>`;
    }
  };
  paintMode();
  const repaint = setInterval(paintMode, 1000);

  createLobby({
    container: wrap.querySelector('#lobby') as HTMLElement,
    net,
    rounds: rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: 2,
    onCancel: () => leaveRoom(),
  });
  hudTimer = repaint;
}

async function leaveRoom(): Promise<void> {
  rounds?.destroy();
  rounds = null;
  session?.destroy();
  session = null;
  clearRoomInUrl();
  const n = net;
  net = null;
  showMenu();
  try {
    await n?.leave();
  } catch {
    /* leaving is best-effort */
  }
}

function startNetRound(info: RoundInfo): void {
  const opts = info.opts as { mode?: string } | undefined;
  // Validate off the wire: an unknown id must fall back, never reach the
  // generator as undefined.
  const roundMode = modeOf(opts?.mode);
  session?.destroy();
  session = new Session({
    mode: roundMode,
    seed: info.seed,
    roster: info.players.map((p) => ({ id: p.id, name: p.name })),
    round: info.round,
    selfId: net?.selfId ?? SELF_ID,
    isHost: info.isHost,
    bus,
    onUpdate: onSessionUpdate,
    onEnd: () => showResults(),
  });
  armed = false;
  animatedPly = 0;
  resultsShown = false;
  renderGame(undefined, true);
  // Count everyone in before the first move is legal.
  const host = document.querySelector('.game-wrap') as HTMLElement | null;
  countdown = createCountdown({
    root: host ?? app,
    sfx,
    reducedMotion,
    onDone: () => {
      armed = true;
      session?.start();
      renderGame();
    },
  });
}

// ── the game screen ─────────────────────────────────────────────────────────

function seatName(seat: Seat): string {
  const p = session?.playerAt(seat);
  if (!p) return seat === 'w' ? 'White' : 'Black';
  return p.id === net?.selfId || p.id === SELF_ID ? `${p.name} (you)` : p.name;
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderGame(anim?: AnimHint, fresh = false): void {
  const s = session;
  // NEVER navigate from here. This runs from the net handlers (a peer joining,
  // the host settling), which fire while the players are still sitting in the
  // LOBBY with no session — and a `showMenu()` fallback here ejected BOTH peers
  // to the menu the instant the second one joined. Repainting is this function's
  // only job; deciding which screen to be on belongs to the caller.
  if (!s) return;
  // Only repaint a game screen that is actually mounted. Without this, a net
  // event arriving just AFTER the round ended (the host leaving is exactly that:
  // peer-leave ends the round, shows the summary, and then the same handler
  // repaints) rebuilt the board straight over the results screen and stranded the
  // survivor on a dead board — the precise failure principle #9 forbids.
  if (!fresh && !document.querySelector('.game-wrap')) return;
  setPlaying(true);

  if (fresh || !board) {
    screen(`
      <div class="game-wrap">
        <div class="side-bar top" id="bar-top"></div>
        <div class="tide" aria-hidden="true"><div class="tide-fill" id="tide"></div><div class="tide-mid"></div></div>
        <div class="board-host" id="board-host"></div>
        <div class="side-bar bottom" id="bar-bottom"></div>
        <div class="ticker" id="ticker"></div>
        <div class="game-actions">
          <button class="btn ghost" id="leave" type="button">Menu</button>
          <button class="btn ghost" id="resign" type="button">Resign</button>
          <button class="btn ghost" id="sound" type="button">${sfx.muted() ? 'Sound off' : 'Sound on'}</button>
        </div>
      </div>`);
    board = createBoard({
      root: document.getElementById('board-host') as HTMLElement,
      variant: s.game.variant,
      reducedMotion,
      onMove: (from, to, promo, keep) => armed && s.playLocal(from, to, promo, keep),
    });
    document.getElementById('leave')?.addEventListener('click', () => {
      if (net) {
        session?.destroy();
        showLobby();
      } else {
        session?.destroy();
        session = null;
        showMenu();
      }
    });
    document.getElementById('resign')?.addEventListener('click', () => {
      if (!s.game.outcome().over && confirmResign()) s.resign();
    });
    document.getElementById('sound')?.addEventListener('click', (e) => {
      sfx.setMuted(!sfx.muted());
      store.set('muted', sfx.muted());
      (e.target as HTMLElement).textContent = sfx.muted() ? 'Sound off' : 'Sound on';
    });
    if (!hudTimer) hudTimer = setInterval(paintHud, 500);
  }

  const out = s.game.outcome();
  const myTurn = s.isLocalTurn() && armed;
  board.render(
    {
      pos: s.game.pos,
      legal: myTurn ? s.game.legal() : [],
      interactive: myTurn,
      flipped: s.localSeat() === 'b',
      lastMove: lastMoveOf(),
      checkSq: out.over ? null : inCheck(s.game.variant, s.game.pos) ? kingSquare(s.game.pos, s.game.pos.turn) : null,
    },
    anim,
  );
  paintTide();
  paintHud();
  if (!out.over) maybeMoveAi();
}

/**
 * The material tide. It swings constantly, because the morph CIRCULATES material
 * rather than accumulating it, and watching it whip back after a bad recapture is
 * most of the feedback the game gives. Read from a quiescence-resolved score for
 * the same reason the balance sim does: raw material mid-exchange is a liar.
 */
function paintTide(): void {
  const s = session;
  const tide = document.getElementById('tide');
  if (!s || !tide) return;
  const mine = s.localSeat() ?? 'w';
  const q = quietEval(s.game.variant, s.game.pos) * (mine === 'w' ? 1 : -1);
  tide.style.width = `${Math.max(4, Math.min(96, 50 + (q / 2000) * 50))}%`;
}

function confirmResign(): boolean {
  return window.confirm('Resign this game?');
}

function lastMoveOf(): { from: number; to: number } | null {
  const last = session?.game.played.at(-1);
  return last ? { from: moveFrom(last.move), to: moveTo(last.move) } : null;
}

function paintHud(): void {
  const s = session;
  if (!s) return;
  const top = document.getElementById('bar-top');
  const bottom = document.getElementById('bar-bottom');
  if (!top || !bottom) return;
  const mine = s.localSeat() ?? 'w';
  const theirs: Seat = mine === 'w' ? 'b' : 'w';
  const turn = s.turnSeat();

  const bar = (seat: Seat): string =>
    `<div class="who ${seat === turn && !s.game.outcome().over ? 'active' : ''}">
       <span class="chip ${seat}"></span>
       <span class="nm">${esc(seatName(seat))}</span>
       ${s.hasLeft(seat) ? '<span class="gone">left</span>' : ''}
     </div>
     <div class="clock ${s.game.clock[seat] < 30_000 ? 'low' : ''}">${fmtClock(s.game.clock[seat])}</div>`;

  top.innerHTML = bar(theirs);
  bottom.innerHTML = bar(mine);

  const ticker = document.getElementById('ticker');
  if (ticker) {
    const last = s.game.played.at(-1);
    const out = s.game.outcome();
    if (out.over) ticker.textContent = outcomeText();
    else if (!armed) ticker.textContent = 'Get ready…';
    else if (last) {
      ticker.textContent =
        last.nowType !== last.wasType
          ? `${last.text} — it became a ${nameOf(last.nowType)}`
          : last.text;
    } else ticker.textContent = s.isLocalTurn() ? 'Your move' : 'Waiting…';
  }
}

function nameOf(t: number): string {
  return ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'][t] ?? 'piece';
}

/** Sound + flourish for a move that just landed — local, remote or AI. */
function celebrateMove(): void {
  const s = session;
  if (!s) return;
  const last = s.game.played.at(-1);
  if (!last) return;
  const to = moveTo(last.move);
  const morphed = last.nowType !== last.wasType;
  if (last.tookType !== 0) {
    if (last.nowType > last.wasType) sfx.play('powerup');
    else if (last.nowType < last.wasType) sfx.play('hit');
    else sfx.play('coin');
  } else {
    sfx.play('blip');
  }
  const out = s.game.outcome();
  if (!out.over && inCheck(s.game.variant, s.game.pos)) {
    sfx.play('jump');
    shake('small');
  } else if (morphed && !reducedMotion) {
    shake('small');
  }
  if (out.over) {
    sfx.play(out.winner === 0 ? 'select' : out.winner === (s.localSeat() === 'w' ? 1 : -1) ? 'win' : 'lose');
    shake('big');
  }
  renderGame({ from: moveFrom(last.move), to, morphed });
}

function shake(size: 'small' | 'big'): void {
  if (reducedMotion) return;
  const wrap = document.querySelector('.game-wrap');
  if (!wrap) return;
  wrap.classList.remove('shake-small', 'shake-big');
  void (wrap as HTMLElement).offsetWidth;
  wrap.classList.add(size === 'big' ? 'shake-big' : 'shake-small');
}

// ── results ─────────────────────────────────────────────────────────────────

function outcomeText(): string {
  const s = session;
  if (!s) return '';
  const out = s.game.outcome();
  if (!out.over) return '';
  const reason = {
    checkmate: 'checkmate',
    stalemate: 'stalemate',
    fifty: 'the fifty-move rule',
    repetition: 'threefold repetition',
    material: 'no mating material',
    timeout: 'a flag fall',
    resign: 'a resignation',
  }[out.reason];
  if (out.winner === 0) return `Draw by ${reason}.`;
  const seat: Seat = out.winner === 1 ? 'w' : 'b';
  return `${seatName(seat)} wins by ${reason}.`;
}

function showResults(): void {
  const s = session;
  if (!s) return showMenu();
  setPlaying(false);
  const sum = s.game.summary();
  const out = sum.outcome;
  const mine = s.localSeat() ?? 'w';
  if (out.over && !resultsShown) {
    resultsShown = true;
    const win = out.winner === 0 ? 'd' : out.winner === (mine === 'w' ? 1 : -1) ? 'w' : 'l';
    tally[win]++;
    rounds?.finish();
  }

  const card = (seat: Seat): string => {
    const r = sum[seat];
    return `<div class="pcard ${seat === mine ? 'me' : ''}">
      <h3><span class="chip ${seat}"></span>${esc(seatName(seat))}</h3>
      <dl>
        <div><dt>Captures</dt><dd>${r.captures}</dd></div>
        <div><dt>Grew</dt><dd>${r.upgrades}</dd></div>
        <div><dt>Shrank</dt><dd>${r.downgrades}</dd></div>
        <div><dt>Material</dt><dd>${r.material > 0 ? '+' : ''}${(r.material / 100).toFixed(1)}</dd></div>
      </dl>
      <p class="pnote">${r.bestMorph ? `Best change: <strong>${esc(r.bestMorph.text)}</strong>` : 'No captures made.'}</p>
      <p class="pnote missed">${
        r.bestMissed
          ? `Missed: <strong>${esc(r.bestMissed.text)}</strong> was there on move ${Math.ceil(r.bestMissed.ply / 2)}`
          : 'Took every chance worth taking.'
      }</p>
    </div>`;
  };

  const multi = net !== null;
  const wrap = screen(`
    <main class="main-content results">
      <h2 class="res-head">${esc(outcomeText() || 'Game over')}</h2>
      <p class="res-sub">${sum.plies} moves · ${esc(s.game.mode.name)}${multi ? ` · match ${tally.w}–${tally.l}${tally.d ? `–${tally.d}` : ''}` : ''}</p>
      <div class="pcards">${card('w')}${card('b')}</div>
      <div class="res-actions" id="res-actions"></div>
      <p class="res-hint">Both sides are shown — the morph means the material column rarely tells the whole story.</p>
    </main>${FOOTER}`);

  const actions = wrap.querySelector('#res-actions') as HTMLElement;
  if (!multi) {
    actions.innerHTML = `<button class="btn primary" id="again" type="button">Play again</button>
      <button class="btn ghost" id="menu" type="button">Menu</button>`;
    actions.querySelector('#again')?.addEventListener('click', () => startSolo(mine === 'w'));
    actions.querySelector('#menu')?.addEventListener('click', () => {
      session?.destroy();
      session = null;
      showMenu();
    });
    return;
  }
  paintRematch(actions);
}

function paintRematch(host: HTMLElement): void {
  const r = rounds;
  if (!r) return;
  const st = r.state();
  const waiting = st.votes.length;
  const present = st.present.length;
  const secs = st.startsInMs === null ? null : Math.ceil(st.startsInMs / 1000);
  host.innerHTML = `
    <button class="btn primary" id="again" type="button" ${st.voted ? 'disabled' : ''}>${st.voted ? 'Ready — waiting' : 'Play again'}</button>
    ${st.isHost && st.canStart ? '<button class="btn" id="force" type="button">Start now</button>' : ''}
    <button class="btn ghost" id="lobby" type="button">Back to lobby</button>
    <button class="btn ghost" id="menu" type="button">Leave room</button>
    <p class="rematch-state">${
      secs !== null
        ? `Next game in ${secs}s…`
        : `${waiting} of ${present} ready${st.voted ? ' — they can still be reading the summary' : ''}`
    }</p>`;
  host.querySelector('#again')?.addEventListener('click', () => {
    sfx.play('select');
    r.vote();
    paintRematch(host);
  });
  host.querySelector('#force')?.addEventListener('click', () => r.go());
  host.querySelector('#lobby')?.addEventListener('click', () => showLobby());
  host.querySelector('#menu')?.addEventListener('click', () => void leaveRoom());
  if (!hudTimer) hudTimer = setInterval(() => paintRematch(host), 500);
}

// ── boot ────────────────────────────────────────────────────────────────────

function boot(): void {
  hardenViewport();
  playerName = resolveName(store, () => `Player ${Math.floor(Math.random() * 900 + 100)}`);
  document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
  window.addEventListener('beforeunload', () => {
    void net?.leave();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') board?.clearSelection();
  });

  // ?room= is honoured ONCE. It is cleared on the way out of a room, so a reload
  // can never silently drag someone back into a room they left.
  const deepLink = new URL(location.href).searchParams.get('room');
  if (deepLink) {
    clearRoomInUrl();
    enterRoom(normalizeRoomCode(deepLink), false);
    return;
  }
  showMenu();
}

boot();
