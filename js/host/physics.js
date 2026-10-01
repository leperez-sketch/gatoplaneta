// =====================================================================
//  GATO SWING · Física compartida (juego + generador de ritmo + tests)
//  Todas las medidas en "unidades de mundo". El radio de la rueda (cabeza
//  del gato) es R. El jugador siempre está en s = 0 (la cima de la cabeza);
//  "s" es la distancia a lo largo de la superficie (+ = derecha).
// =====================================================================

export const PHYS = {
  R: 7.5,             // radio de la cabeza-rueda
  DEPTH: 4.4,         // grosor de la rueda (carriles de jugadores en z)
  G: 60,              // gravedad
  JUMP_V: 17.5,       // velocidad inicial de salto
  PLAYER_HALF_W: 0.26,// mitad del ancho del hitbox del jugador (más angosto que el modelo = justo)
  PLAYER_H: 1.25,     // alto del hitbox del jugador
  SPAWN_ARC: 1.3,     // ángulo (rad) desde la cima donde aparecen los obstáculos
  EXIT_ARC: 0.75,     // ángulo (rad) pasado el jugador donde desaparecen (puf)
  STEP: 1 / 240,      // paso fijo de simulación de colisiones
  JUMP_BUFFER: 0.12,  // si presionas saltar justo antes de aterrizar, se guarda
};
PHYS.AIR_TIME = (2 * PHYS.JUMP_V) / PHYS.G;               // ≈ 0.583 s
PHYS.APEX = (PHYS.JUMP_V * PHYS.JUMP_V) / (2 * PHYS.G);    // ≈ 2.55 u

/** Altura de los pies `dt` segundos después de despegar (0 si ya aterrizó). */
export function jumpHeight(dt) {
  if (dt <= 0 || dt >= PHYS.AIR_TIME) return 0;
  return PHYS.JUMP_V * dt - 0.5 * PHYS.G * dt * dt;
}

// ---------------------------------------------------------------------
//  Perfiles de colisión. Cada obstáculo es una unión de primitivas en
//  coordenadas locales (x = a lo largo de la superficie, centrado en el
//  obstáculo; y = altura desde el suelo). Los MISMOS números construyen
//  la malla 3D, así que lo que ves es exactamente lo que golpea.
//    box:  {t:'box', x0, x1, y0, y1}
//    circ: {t:'circ', cx, cy, r}
//    tri:  {t:'tri', x0, x1, y0, y1}   (triángulo isósceles, punta arriba)
// ---------------------------------------------------------------------

/** ¿Choca el rectángulo del jugador (pies en `feet`) con el obstáculo centrado en `s`? */
export function hitTest(s, feet, prims) {
  const hw = PHYS.PLAYER_HALF_W;
  const top = feet + PHYS.PLAYER_H;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (p.t === 'box') {
      if (s + p.x0 < hw && s + p.x1 > -hw && feet < p.y1 && top > p.y0) return true;
    } else if (p.t === 'circ') {
      const cx = s + p.cx;
      const nx = Math.max(-hw, Math.min(hw, cx));
      const ny = Math.max(feet, Math.min(top, p.cy));
      const dx = cx - nx, dy = p.cy - ny;
      if (dx * dx + dy * dy < p.r * p.r) return true;
    } else if (p.t === 'tri') {
      const a = Math.max(-hw, s + p.x0);
      const b = Math.min(hw, s + p.x1);
      if (a >= b) continue;
      const c = s + (p.x0 + p.x1) / 2;
      const half = (p.x1 - p.x0) / 2;
      let peak;
      if (c >= a && c <= b) peak = p.y1;
      else {
        const e = c < a ? a : b;
        peak = p.y0 + (p.y1 - p.y0) * (1 - Math.abs(e - c) / half);
      }
      if (feet < peak && top > p.y0) return true;
    }
  }
  return false;
}

/** Caja envolvente de un perfil: {x0,x1,h}. */
export function profileBounds(prims) {
  let x0 = Infinity, x1 = -Infinity, h = 0;
  for (const p of prims) {
    if (p.t === 'circ') {
      x0 = Math.min(x0, p.cx - p.r); x1 = Math.max(x1, p.cx + p.r); h = Math.max(h, p.cy + p.r);
    } else {
      x0 = Math.min(x0, p.x0); x1 = Math.max(x1, p.x1); h = Math.max(h, p.y1);
    }
  }
  return { x0, x1, h };
}

/**
 * Ventana de salto: prueba todos los momentos de despegue posibles alrededor
 * de la llegada y devuelve el rango continuo más largo que esquiva el obstáculo.
 * Usa exactamente la misma función de colisión que el juego.
 *   v   = velocidad del obstáculo (u/s)
 *   return {window, best, from, to} en segundos relativos a la llegada.
 */
export function jumpWindow(prims, v) {
  const b = profileBounds(prims);
  const reach = Math.max(-b.x0, b.x1) + PHYS.PLAYER_HALF_W + 0.05;
  const tIn = -reach / v - 0.02, tOut = reach / v + 0.02; // tiempo en que hay solapamiento horizontal posible
  let bestLen = 0, bestFrom = 0, bestTo = 0, curFrom = null;
  const dTau = 0.004;
  for (let tau = -PHYS.AIR_TIME - 0.1; tau <= 0.25; tau += dTau) {
    let ok = true;
    for (let t = tIn; t <= tOut; t += PHYS.STEP) {
      const s = -v * (0 - t); // el obstáculo viaja hacia +s y pasa por 0 en t=0 (simétrico)
      const feet = jumpHeight(t - tau);
      if (hitTest(s, feet, prims)) { ok = false; break; }
    }
    if (ok) { if (curFrom === null) curFrom = tau; }
    else if (curFrom !== null) {
      const len = tau - dTau - curFrom;
      if (len > bestLen) { bestLen = len; bestFrom = curFrom; bestTo = tau - dTau; }
      curFrom = null;
    }
  }
  if (curFrom !== null) { const len = 0.25 - curFrom; if (len > bestLen) { bestLen = len; bestFrom = curFrom; bestTo = 0.25; } }
  return { window: bestLen, from: bestFrom, to: bestTo, best: (bestFrom + bestTo) / 2 };
}
