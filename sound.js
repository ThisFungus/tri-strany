// Original synthesized game-show cues (Web Audio, no files). Browsers allow audio only after a user gesture,
// so the context is created on the first pointer/key event. Mute state is per browser.
(function () {
  'use strict';
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('ts-muted') === '1'; } catch (e) { /* storage blocked */ }

  function unlock() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; } }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  ['pointerdown', 'keydown'].forEach(t => window.addEventListener(t, unlock, { capture: true }));

  // One note: type, start/end frequency (Hz), start offset and length (s), peak gain.
  function tone(type, f0, f1, at, len, gain) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + len);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + len + 0.02);
  }

  const CUES = {
    pick: () => { tone('sine', 880, 880, 0, 0.09, 0.15); tone('sine', 1320, 1320, 0.05, 0.12, 0.08); },
    tick: () => tone('square', 1200, 1200, 0, 0.03, 0.04),
    correct: () => { tone('triangle', 659, 659, 0, 0.14, 0.25); tone('triangle', 988, 988, 0.12, 0.28, 0.25); },
    wrong: () => { tone('sawtooth', 220, 110, 0, 0.45, 0.12); tone('square', 110, 80, 0, 0.45, 0.05); },
    steal: () => { CUES.wrong(); tone('triangle', 523, 523, 0.55, 0.1, 0.18); tone('triangle', 523, 523, 0.69, 0.1, 0.18); },
    black: () => tone('sine', 140, 55, 0, 0.5, 0.35),
    start: () => [392, 523, 659].forEach((f, i) => tone('triangle', f, f, i * 0.11, 0.18, 0.2)),
    win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone('triangle', f, f, i * 0.13, i === 5 ? 0.6 : 0.16, 0.22)),
  };

  window.TS_SOUND = {
    play(name) {
      if (muted || !ctx || ctx.state === 'closed' || !CUES[name]) return; // while still resuming, notes queue and play
      try { CUES[name](); } catch (e) { /* audio is optional */ }
    },
    get muted() { return muted; },
    setMuted(v) { muted = !!v; try { localStorage.setItem('ts-muted', muted ? '1' : '0'); } catch (e) { /* ignore */ } },
  };
})();
