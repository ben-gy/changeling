/**
 * screens.test.ts — source-level invariants on main.ts's screen wiring.
 *
 * These are ratchets, not proofs, and they exist because the bug they pin was
 * invisible to every other gate: the game built, typechecked, passed 130 unit
 * tests, and played perfectly solo — and multiplayer was TOTALLY broken. The net
 * handlers (`onPeers`, `onHostChange`) call the game's repaint, which fires while
 * both players are still in the LOBBY with no session yet. A `showMenu()`
 * fallback inside that repaint therefore ejected BOTH peers to the menu the
 * instant the second one joined the room.
 *
 * Only the two-tab smoke test found it. This file makes sure a future edit
 * cannot quietly re-arm it between smoke tests.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('src/main.ts', 'utf8');

/** Strip comments, so an assertion reads the CODE and not a note about it. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Extract a top-level `function name(...) { ... }` body by brace matching. */
function bodyOf(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${name} not found in main.ts`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return stripComments(src.slice(open, i + 1));
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('the repaint never navigates', () => {
  it('renderGame never FALLS BACK to the menu', () => {
    // Scoped deliberately to the bug's shape (`return showMenu()`), because this
    // function also wires the Menu button — a navigation the player asked for is
    // fine; a navigation triggered by "there is no session yet" is the defect.
    const body = bodyOf('renderGame');
    expect(body, 'renderGame runs from net handlers with no session — it must repaint, not navigate').not.toMatch(
      /return\s+showMenu\s*\(/,
    );
  });

  it('renderGame bails out rather than rendering a missing session', () => {
    expect(bodyOf('renderGame')).toMatch(/if\s*\(!s\)\s*return;/);
  });

  it('renderGame refuses to rebuild a game screen that is not mounted', () => {
    // The host-leave path: peer-leave ends the round and shows the summary, then
    // the SAME net handler repaints — which rebuilt the board over the results
    // and stranded the survivor on a dead board. Every player must reach the
    // summary (principle #9), including one whose round ended by the host
    // vanishing.
    expect(bodyOf('renderGame')).toMatch(
      /if\s*\(!fresh\s*&&\s*!document\.querySelector\('\.game-wrap'\)\)\s*return;/,
    );
  });

  it('every net handler guards the repaint on there being a session', () => {
    // onPeers / onHostChange / onPeerLeave all fire in the lobby.
    const start = src.indexOf('createNet(');
    const chunk = src.slice(start, src.indexOf('rounds = createRounds', start));
    for (const handler of ['onHostChange', 'onPeerLeave', 'onPeers']) {
      expect(chunk, `${handler} must not repaint a game that has not started`).toContain(handler);
    }
    const bare = chunk.match(/^\s*renderGame\(\),?$/gm) ?? [];
    expect(bare, 'an unguarded renderGame() in a net handler re-arms the lobby eject').toHaveLength(0);
  });
});

describe('the room is joined once and left deliberately', () => {
  it('creates exactly one Net, and only inside enterRoom', () => {
    expect(src.match(/createNet\(/g) ?? []).toHaveLength(1);
    expect(bodyOf('enterRoom')).toContain('createNet(');
  });

  it('never leaves a room outside the explicit leave path', () => {
    // net.leave() belongs to leaveRoom and to unload. Anywhere else is the
    // leave/rejoin trap, which produces two peers alone in the right room.
    const leaves = src.match(/net\??\.?leave\(\)/g) ?? [];
    expect(leaves.length).toBeLessThanOrEqual(2);
    expect(bodyOf('leaveRoom')).toMatch(/leave\(\)/);
  });

  it('clears ?room= on the way out so a reload cannot drag you back in', () => {
    expect(bodyOf('leaveRoom')).toContain('clearRoomInUrl');
    expect(bodyOf('boot')).toContain('clearRoomInUrl');
  });

  it('starts a rematch through rounds, never by rebuilding the room', () => {
    const body = bodyOf('paintRematch');
    expect(body).toMatch(/r\.vote\(\)/);
    expect(body).toMatch(/r\.go\(\)/);
    expect(body).not.toMatch(/createNet|enterRoom/);
  });
});

describe('the host’s mode is what the room plays', () => {
  it('freezes the mode into the round start rather than reading it per peer', () => {
    expect(bodyOf('enterRoom')).toMatch(/roundOpts:\s*\(\)\s*=>\s*\(\{\s*mode:\s*mode\.id\s*\}\)/);
  });

  it('validates the mode that arrives off the wire', () => {
    expect(bodyOf('startNetRound')).toMatch(/modeOf\(opts\?\.mode\)/);
  });

  it('shows a guest the HOST’s gossiped pick, not its own selection', () => {
    expect(bodyOf('showLobby')).toContain('hostOpts');
  });
});
