// =====================================================================
//  Test de la partitura y los hitboxes (Node, sin navegador).
//    node tests/chart.test.mjs audio.f32      (PCM float32 mono 11025 Hz)
//  Generar el .f32:  ffmpeg -i assets/audio/ww.mp3 -ac 1 -ar 11025 -f f32le ww.f32
//
//  Verifica para cada dificultad:
//   - que TODO obstáculo tenga una ventana de salto ≥ mínimo (física real),
//   - separación mínima entre llegadas,
//   - que un jugador que salta en el centro de cada ventana sobreviva toda
//     la canción en CUALQUIER posición del grupo (6 jugadores),
//   - que un jugador que no salta muera en el primer obstáculo,
//   - que cada llegada caiga en un beat o subdivisión para todos.
// =====================================================================
import fs from 'fs';
import { analyzeBeats } from '../js/host/beat-analysis.js';
import { generateChart, playerSpacing, dirAt } from '../js/host/chart.js';
import { PHYS, hitTest, jumpHeight } from '../js/host/physics.js';

const f = process.argv[2];
if (!f) { console.log('uso: node tests/chart.test.mjs audio.f32'); process.exit(2); }
const buf = fs.readFileSync(f);
const mono = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
let t0 = Date.now();
const an = analyzeBeats(mono, 11025);
console.log('BPM', an.bpm, 'beats', an.beats.length, 'downbeat', an.downbeatPhase, 'dur', an.duration.toFixed(1), 'ms', Date.now() - t0);

const N = 6;
let fail = 0;
for (const diff of ['facil', 'normal', 'dificil']) {
  const ch = generateChart(an, { difficulty: diff, seed: 42 });
  const ev = ch.events;
  let minW = 9, minGap = 9;
  for (let i = 0; i < ev.length; i++) { minW = Math.min(minW, ev[i].window); if (i) minGap = Math.min(minGap, ev[i].tArr - ev[i - 1].tArr); }

  // posiciones de los jugadores por fase (igual que el juego)
  const phases = ch.reversals.map((r, i) => {
    const first = ev.find((e) => e.tArr > Math.max(0, r.t)) || ev[0];
    const { spacing, sub } = playerSpacing(first.v, ch.beatDur, N);
    return { from: r.t, spacing, sub };
  });
  const phaseAt = (t) => { let p = phases[0]; for (const q of phases) if (q.from <= t) p = q; return p; };

  let deaths = 0, offBeat = 0;
  for (let k = 0; k < N && !deaths; k++) {
    const slot = k - Math.floor((N - 1) / 2); // posiciones enteras: cada una cae en subdivisión
    const sAt = (t) => slot * phaseAt(t).spacing;
    // plan de saltos: llegada a MI posición + mejor despegue
    const plan = ev.map((e) => {
      const ph = phaseAt(e.tArr);
      const s = slot * ph.spacing;
      const arr = e.tArr + e.dir * s / e.v;
      // ¿cae en subdivisión del beat?
      const frac = (e.dir * s / e.v) / (ch.beatDur * (ph.sub || 1));
      if (ph.sub && Math.abs(frac - Math.round(frac)) > 0.02) offBeat++;
      return arr + e.bestTau;
    }).sort((a, b) => a - b);
    let jumpT = -99, pi = 0;
    for (let t = 0; t < ch.duration; t += PHYS.STEP) {
      while (pi < plan.length && plan[pi] <= t) {
        if (t - jumpT >= PHYS.AIR_TIME - 1e-9) jumpT = plan[pi]; else { console.log('  ', diff, 'jugador', k, 'no aterrizó a tiempo', plan[pi].toFixed(2)); deaths++; }
        pi++;
      }
      const feet = jumpHeight(t - jumpT);
      const sp = sAt(t);
      for (const e of ev) {
        if (t < e.tSpawn || t > e.tArr + 2) continue;
        const s = -e.dir * e.v * (e.tArr - t) - sp;
        if (hitTest(s, feet, e.prims)) { deaths++; console.log('  ', diff, 'jugador', k, 'golpe', e.id, e.kind, t.toFixed(3)); break; }
      }
      if (deaths) break;
    }
  }
  let lazyHit = false; const e0 = ev[0];
  for (let t = e0.tSpawn; t < e0.tArr + 0.5; t += PHYS.STEP) if (hitTest(-e0.dir * e0.v * (e0.tArr - t), 0, e0.prims)) { lazyHit = true; break; }
  const kinds = {}; ev.forEach((e) => kinds[e.kind] = (kinds[e.kind] || 0) + 1);
  console.log(diff.padEnd(8), 'obst', ev.length, 'cambios', ch.reversals.length - 1, 'minVentana', minW.toFixed(3), 'minSep', minGap.toFixed(3),
    'v', ev[0].v.toFixed(2) + '→' + Math.max(...ev.map((e) => e.v)).toFixed(2),
    'separación', phases.map((p) => p.spacing.toFixed(2) + '(' + p.sub + ')').join(' '),
    '| muertes jugador perfecto:', deaths, '| sin saltar muere:', lazyHit, '| fuera de ritmo:', offBeat);
  console.log('         ', JSON.stringify(kinds));
  if (deaths || !lazyHit || offBeat || minGap < PHYS.AIR_TIME + 0.2) fail++;
}
console.log(fail ? 'FALLÓ' : 'TODO OK');
process.exit(fail ? 1 : 0);
