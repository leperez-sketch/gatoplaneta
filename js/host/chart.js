// =====================================================================
//  Generador de "partitura" de obstáculos a partir del análisis de beats.
//  - Cada obstáculo LLEGA al jugador exactamente en un beat.
//  - La rueda manda obstáculos de izquierda→derecha o derecha→izquierda;
//    cambia de sentido en inicios de frase con aviso.
//  - Cada obstáculo se valida con la física real: siempre existe una
//    ventana de salto de al menos `minWindow` segundos. Si no, se encoge.
// =====================================================================
import { PHYS, jumpWindow } from './physics.js';
import { KIND_LIST, makeObstacleShape } from './catalog.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DIFFICULTY = {
  facil:   { label: 'Fácil',   minWindow: 0.20, gapExtra: 0.20, travelMul: 1.18, bias: -0.25, sizeMul: 0.75, revProb: 0.25 },
  normal:  { label: 'Normal',  minWindow: 0.15, gapExtra: 0.08, travelMul: 1.0,  bias: 0.0,   sizeMul: 1.0,  revProb: 0.38 },
  dificil: { label: 'Difícil', minWindow: 0.11, gapExtra: 0.0,  travelMul: 0.86, bias: 0.22,  sizeMul: 1.0,  revProb: 0.5 },
};

const cache = new Map();
function windowFor(shape, v) {
  const key = shape.kind + '|' + shape.w.toFixed(3) + '|' + shape.h.toFixed(3) + '|' + v.toFixed(2);
  let r = cache.get(key);
  if (!r) { r = jumpWindow(shape.prims, v); cache.set(key, r); }
  return r;
}

export function generateChart(an, opts = {}) {
  const D = DIFFICULTY[opts.difficulty] || DIFFICULTY.normal;
  const rng = mulberry32(opts.seed >>> 0 || 1234);
  const { beats, strength, energy, duration } = an;
  const bd = an.beatDur;
  const minGap = PHYS.AIR_TIME + 0.24 + D.gapExtra; // tiempo mínimo entre llegadas consecutivas
  const firstT = Math.max(4.0, opts.leadIn || 4.0);
  const lastT = duration - 1.2;
  const PHRASE = 16;
  const REV_CLEAR = 1.3; // s libres antes de un cambio de sentido
  const phase0 = an.downbeatPhase || 0;

  const events = [];
  const reversals = []; // {t, dir}
  let dir = rng() < 0.5 ? 1 : -1;
  reversals.push({ t: -999, dir });
  let travel = null;            // tiempo de viaje del sentido actual
  let lastArrival = -999;
  let blockUntil = 0;           // tras un cambio de sentido no hay llegadas antes de esto
  let phrasesSinceRev = 0;
  let prevKind = '';

  // Agrupa los beats en frases de 16 alineadas al tiempo 1
  for (let start = phase0; start < beats.length; start += PHRASE) {
    const idx = [];
    for (let i = start; i < Math.min(beats.length, start + PHRASE); i++) idx.push(i);
    if (!idx.length) break;
    const tStart = beats[idx[0]];
    if (beats[idx[idx.length - 1]] < firstT) continue;
    if (tStart > lastT) break;

    const meanE = idx.reduce((a, i) => a + energy[i], 0) / idx.length;
    const progress = tStart / duration;
    const intensity = Math.max(0, Math.min(1, 0.6 * meanE + 0.4 * progress + D.bias));
    const level = intensity < 0.28 ? 0 : intensity < 0.55 ? 1 : intensity < 0.8 ? 2 : 3;

    // Tiempo de viaje objetivo (más rápido hacia el final)
    const target = (2.15 - 0.6 * progress) * D.travelMul;
    const travelBeats = Math.max(2, Math.round(target / bd));
    let newTravel = travelBeats * bd;

    // ¿Cambia de sentido en esta frase?
    if (events.length > 0 && phrasesSinceRev >= 1 && (rng() < D.revProb + 0.06 * level || phrasesSinceRev >= 4)) {
      dir = -dir;
      phrasesSinceRev = 0;
      const tr = tStart;
      reversals.push({ t: tr, dir });
      travel = newTravel;
      blockUntil = tr + travel + 0.05;
      // las llegadas viejas deben acabar antes del cambio
      // las llegadas viejas deben acabar antes del cambio (margen para jugadores alejados del centro)
      while (events.length && events[events.length - 1].tArr > tr - REV_CLEAR) events.pop();
      lastArrival = events.length ? events[events.length - 1].tArr : -999;
    } else {
      phrasesSinceRev++;
      // La velocidad solo cambia en los cambios de sentido: así los jugadores
      // (separados por fracciones de beat) siempre quedan sincronizados.
      if (travel === null) travel = newTravel;
    }

    const gapBeats = [4, 2, 2, 1][level];
    const allowDoubles = level >= 2;
    let maxCount = Math.ceil(idx.length / gapBeats);
    if (allowDoubles) maxCount += 2;

    // Candidatos ordenados por musicalidad
    const cands = idx
      .filter((i) => beats[i] >= Math.max(firstT, blockUntil) && beats[i] <= lastT)
      .map((i) => {
        const pos = ((i - phase0) % 4 + 4) % 4;
        const accent = pos === 0 ? 0.35 : pos === 2 ? 0.15 : 0;
        return { i, t: beats[i], sc: strength[i] + accent + rng() * 0.15 };
      })
      .sort((a, b) => b.sc - a.sc);

    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= maxCount) break;
      const gapNeeded = Math.max(minGap, (allowDoubles ? 1 : gapBeats) * bd - 0.01);
      const near = (t) => Math.abs(t - c.t) < Math.max(minGap, (chosen.length < idx.length / gapBeats ? gapBeats : 1) * bd - 0.01);
      if (c.t - lastArrival < gapNeeded) continue;
      if (chosen.some((o) => near(o.t))) continue;
      chosen.push(c);
    }
    chosen.sort((a, b) => a.t - b.t);

    const v = (PHYS.SPAWN_ARC * PHYS.R) / travel;
    for (const c of chosen) {
      if (c.t - lastArrival < minGap) continue;
      // tipo y tamaño
      let kind;
      do { kind = KIND_LIST[Math.floor(rng() * KIND_LIST.length)]; } while (kind === prevKind && KIND_LIST.length > 1);
      prevKind = kind;
      const big = Math.min(1, strength[c.i] * 0.7 + rng() * 0.5) * D.sizeMul;
      let sw = Math.min(1, big * (0.6 + rng() * 0.6));
      let sh = Math.min(1, big * (0.6 + rng() * 0.6));
      // Obstáculos seguidos: más pequeños
      if (c.t - lastArrival < minGap + 0.25) { sw *= 0.5; sh *= 0.6; }
      let shape = makeObstacleShape(kind, sw, sh);
      let win = windowFor(shape, v);
      let guard = 0;
      while (win.window < D.minWindow && guard++ < 12) {
        sw *= 0.8; sh *= 0.85;
        shape = makeObstacleShape(kind, sw, sh);
        win = windowFor(shape, v);
      }
      if (win.window < D.minWindow) continue; // imposible: se descarta
      events.push({
        id: events.length,
        tArr: c.t,
        tSpawn: c.t - travel,
        dir, v, travel,
        kind: shape.kind, w: shape.w, h: shape.h, prims: shape.prims,
        window: win.window, bestTau: win.best, winFrom: win.from, winTo: win.to,
        accent: strength[c.i],
        seed: Math.floor(rng() * 1e9),
      });
      lastArrival = c.t;
    }
  }
  events.forEach((e, i) => { e.id = i; });
  return { events, reversals, bpm: an.bpm, beatDur: bd, beats, duration, downbeatPhase: phase0, difficulty: opts.difficulty || 'normal' };
}

/**
 * Separación entre jugadores sobre la cabeza: una fracción musical de beat
 * (1, 1/2 o 1/4) recorrida por los obstáculos, para que a CADA jugador le
 * llegue su obstáculo justo en un tiempo o subdivisión de la música.
 */
export function playerSpacing(v, beatDur, n) {
  const maxSpan = 7.0;
  for (const m of [1, 0.5, 0.25]) {
    const sp = v * beatDur * m;
    if (sp >= 0.8 && sp <= 2.2 && sp * Math.max(0, n - 1) <= maxSpan) return { spacing: sp, sub: m };
  }
  for (const m of [0.5, 0.25, 0.125]) { const sp = v * beatDur * m; if (sp >= 0.75) return { spacing: sp, sub: m }; }
  return { spacing: 0.75, sub: 0 };
}

/** Sentido de la rueda en el tiempo t. */
export function dirAt(chart, t) {
  let d = chart.reversals[0].dir;
  for (const r of chart.reversals) { if (r.t <= t) d = r.dir; else break; }
  return d;
}
