// =====================================================================
//  GATO SWING · Lógica del juego en el host
// =====================================================================
import * as THREE from 'three';
import { PHYS, hitTest, jumpHeight, profileBounds } from './physics.js';
import { generateChart, dirAt, playerSpacing } from './chart.js';
import { CatWheel, PAL } from './cat.js';
import { CharacterActor, CHARACTERS, CHAR_HEIGHT } from './characters.js';
import { buildObstacleMesh, buildHitboxMesh } from './obstacles3d.js';
import { FX } from './fx.js';

export const PLAYER_COLORS = ['#ff3b4e', '#22d3ee', '#a3e635', '#ff9f1c', '#e879f9', '#ffffff', '#fb7185', '#2dd4bf', '#facc15', '#a78bfa', '#4ade80', '#f97316'];

const R = PHYS.R, DEPTH = PHYS.DEPTH;
const tmpV = new THREE.Vector3();

function cleanName(n) {
  n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return n || ('Gato ' + Math.floor(100 + Math.random() * 900));
}

export class Game {
  constructor({ bg, gl, fx, audio, templates, ui }) {
    this.audio = audio; this.templates = templates; this.ui = ui;
    this.bgCanvas = bg; this.bg = bg.getContext('2d');
    this.renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8890c0, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 2.3); sun.position.set(6, 14, 12); this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.5, 200);
    this.camLook = new THREE.Vector3(0, 12, 0); this.camPos = new THREE.Vector3(0, 22, 36);
    this.camTarget = { look: new THREE.Vector3(0, 12, 0), pos: new THREE.Vector3(0, 22, 36) };
    this.cat = new CatWheel(this.scene, R, DEPTH);
    this.fx = new FX(fx);
    this.obsLayer = new THREE.Group(); this.scene.add(this.obsLayer);
    this.playersLayer = new THREE.Group(); this.scene.add(this.playersLayer);

    this.players = new Map();
    this.state = 'lobby';
    this.difficulty = 'normal';
    this.analysis = null;
    this.chart = null;
    this.active = [];           // obstáculos vivos
    this.nextEv = 0;
    this.t = 0; this.simT = 0;
    this.revIdx = 0;
    this.showHitboxes = false;
    this.spinSpeed = 0.25;
    this.lobbyClock = 0;
    this.usedChars = [];
    this.colorIdx = 0;
    this.paused = false;
    this.endTimer = null;
    this.lastFrame = performance.now();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.setupKeyboard();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // -------------------------------------------------------------- vista
  resize() {
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = W; this.H = H;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(W, H, false);
    this.bgCanvas.width = Math.round(W * dpr); this.bgCanvas.height = Math.round(H * dpr);
    this.bgDpr = dpr;
    this.fx.resize(W, H, dpr);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.updateCamTargets();
  }
  updateCamTargets() {
    const aspect = this.W / this.H;
    // distancia para que quepan cabeza + brazos a lo ancho
    const halfW = R * 1.5;
    const dist = Math.max(R * 3.2, halfW / (Math.tan(THREE.MathUtils.degToRad(17)) * aspect));
    if (this.state === 'lobby' || this.state === 'loading') {
      this.camTarget.pos.set(0, R * 1.9, dist * 1.08); this.camTarget.look.set(0, R * 1.42, 0);
    } else {
      this.camTarget.pos.set(0, R * 2.15, dist); this.camTarget.look.set(0, R * 1.08, 0);
    }
  }
  project(x, y, z) {
    tmpV.set(x, y, z).project(this.camera);
    return { x: (tmpV.x * 0.5 + 0.5) * this.W, y: (-tmpV.y * 0.5 + 0.5) * this.H };
  }

  // ----------------------------------------------------------- jugadores
  pickChar() {
    const ids = CHARACTERS.map((c) => c.id).filter((id) => this.templates.has(id));
    const reserved = Object.keys(this.loadRoster()).filter((k) => !this.players.has(k)).map((k) => this.loadRoster()[k].charId);
    let free = ids.filter((id) => !this.usedChars.includes(id) && !reserved.includes(id));
    if (!free.length) free = ids.filter((id) => !this.usedChars.includes(id));
    if (!free.length) free = ids;
    const id = free[Math.floor(Math.random() * free.length)];
    this.usedChars.push(id);
    return id;
  }
  nextColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    for (let i = 0; i < PLAYER_COLORS.length; i++) { const c = PLAYER_COLORS[(this.colorIdx + i) % PLAYER_COLORS.length]; if (!used.has(c)) { this.colorIdx++; return c; } }
    return PLAYER_COLORS[this.colorIdx++ % PLAYER_COLORS.length];
  }

  addPlayer(key, opts = {}) {
    let p = this.players.get(key);
    if (p) {
      p.connected = true;
      if (opts.name) { p.name = cleanName(opts.name); this.saveRoster(); }
      this.ui.refreshLobby();
      return p;
    }
    // si la pantalla se recargó, recupera el mismo personaje/color de este celular
    const saved = this.loadRoster()[key];
    let charId, color;
    const usedColors = new Set([...this.players.values()].map((q) => q.color));
    if (saved && this.templates.has(saved.charId) && !this.usedChars.includes(saved.charId)) { charId = saved.charId; this.usedChars.push(charId); }
    else charId = this.pickChar();
    if (saved && saved.color && !usedColors.has(saved.color)) color = saved.color; else color = this.nextColor();
    if (!opts.name && saved && saved.name) opts.name = saved.name;
    const actor = new CharacterActor(this.templates.get(charId), color);
    this.playersLayer.add(actor.group);
    p = {
      key, name: cleanName(opts.name), charId, color, actor,
      isBot: !!opts.bot, kb: opts.kb || 0, remote: !opts.bot && !opts.kb,
      connected: true, alive: true, waiting: this.state !== 'lobby',
      score: 0, combo: 0, maxCombo: 0, cleared: 0, perfects: 0, place: 0,
      t0: null, landT: -99, buffered: false, pending: null, lastMeow: 0,
      lane: 0, s: (Math.random() - 0.5) * 6, walkTarget: 0, walkPause: Math.random() * 2,
      facingDir: Math.random() < 0.5 ? -1 : 1, ko: null, skill: 0.55 + Math.random() * 0.4,
      lastJumpReq: 0,
    };
    if (p.waiting) actor.group.visible = false;
    this.players.set(key, p);
    this.saveRoster();
    this.layoutLanes();
    this.ui.refreshLobby();
    if (p.waiting) this.ui.toast(`${p.name} entrará en la próxima función`);
    return p;
  }

  loadRoster() { try { return JSON.parse(sessionStorage.getItem('gatoswing-roster') || '{}'); } catch (e) { return {}; } }
  saveRoster(removedKey) {
    try {
      const r = this.loadRoster(); // fusiona: los que aún no vuelven tras recargar conservan su puesto
      if (removedKey) delete r[removedKey];
      this.players.forEach((p) => { if (p.remote) r[p.key] = { name: p.name, charId: p.charId, color: p.color }; });
      sessionStorage.setItem('gatoswing-roster', JSON.stringify(r));
    } catch (e) {}
  }

  removePlayer(key) {
    const p = this.players.get(key);
    if (!p) return;
    this.playersLayer.remove(p.actor.group);
    this.players.delete(key);
    const i = this.usedChars.indexOf(p.charId); if (i >= 0) this.usedChars.splice(i, 1);
    this.saveRoster(key);
    this.layoutLanes();
    this.ui.refreshLobby();
  }

  layoutLanes() {
    // lobby: profundidad escalonada para que se vean todos
    const list = [...this.players.values()].filter((p) => !p.waiting);
    list.forEach((p, i) => { p.lane = (i % 2 ? -0.7 : 0.7) * (DEPTH / 4.4); });
  }

  /**
   * Coloca a los jugadores en fila sobre la cabeza, separados por una
   * subdivisión musical (ver playerSpacing). Se llama al empezar y en cada
   * cambio de sentido (cuando no hay obstáculos cerca).
   */
  layoutPlay(t, instant) {
    const ev = this.chart.events.find((e) => e.tArr > t + 0.01) || this.chart.events[this.chart.events.length - 1];
    if (!ev) return;
    const list = [...this.players.values()].filter((p) => !p.waiting && p.alive);
    const n = list.length;
    const { spacing, sub } = playerSpacing(ev.v, this.chart.beatDur, n);
    this.spacingInfo = { spacing, sub };
    list.sort((a, b) => a.s - b.s);
    const lo = -Math.floor((n - 1) / 2);
    list.forEach((p, k) => {
      p.targetS = (lo + k) * spacing;
      p.lane = (k % 2 ? -0.75 : 0.75) * (DEPTH / 4.4);
      if (instant) p.s = p.targetS;
    });
  }

  addBot() {
    const names = ['Don Gato', 'Fígaro', 'Misifú', 'Garfio', 'Pelusa', 'Tom', 'Bigotes', 'Silvestre', 'Michín', 'Botitas'];
    const key = 'bot-' + Math.random().toString(36).slice(2, 7);
    const used = new Set([...this.players.values()].map((p) => p.name));
    const free = names.filter((n) => !used.has('🤖 ' + n));
    const pick = free.length ? free[Math.floor(Math.random() * free.length)] : names[Math.floor(Math.random() * names.length)] + ' ' + (this.players.size + 1);
    return this.addPlayer(key, { bot: true, name: '🤖 ' + pick });
  }
  addKeyboard(slot) {
    const key = 'kb-' + slot;
    if (this.players.has(key)) return;
    this.addPlayer(key, { kb: slot, name: slot === 1 ? 'Teclado 1' : 'Teclado 2' });
  }

  setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.repeat) return;
      const k1 = this.players.get('kb-1'), k2 = this.players.get('kb-2');
      if (e.code === 'Space' || e.code === 'KeyW') { e.preventDefault(); if (k1) this.jump(k1, this.nowSong()); }
      if (e.code === 'ArrowUp' || e.code === 'Enter' && this.state === 'playing') { if (k2) { e.preventDefault(); this.jump(k2, this.nowSong()); } }
      if (e.code === 'KeyM' && k1) this.meow(k1);
      if (e.code === 'KeyN' && k2) this.meow(k2);
      if (e.code === 'KeyH') { this.showHitboxes = !this.showHitboxes; this.ui.toast(this.showHitboxes ? 'Hitboxes visibles (H)' : 'Hitboxes ocultas'); }
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.state === 'playing') this.togglePause();
    });
  }

  // --------------------------------------------------------------- tiempo
  nowSong() {
    if (this.state === 'playing') return this.audio.songTime();
    return this.lobbyClock;
  }
  beatInfo(t) {
    if (this.chart && this.state === 'playing') {
      const b = this.chart.beats;
      let lo = 0, hi = b.length - 1;
      if (t < b[0]) { const bd = this.chart.beatDur; const k = Math.floor((t - b[0]) / bd); return { index: k, phase: ((t - b[0]) / bd) - k }; }
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b[m] <= t) lo = m; else hi = m - 1; }
      const next = b[lo + 1] || (b[lo] + this.chart.beatDur);
      return { index: lo - (this.chart.downbeatPhase || 0), phase: Math.min(1, (t - b[lo]) / (next - b[lo])) };
    }
    const bd = 60 / 104; const k = Math.floor(t / bd);
    return { index: k, phase: t / bd - k };
  }

  // ---------------------------------------------------------------- input
  /** tPress = tiempo de canción en que el jugador presionó (compensado). */
  jump(p, tPress) {
    if (!p || p.waiting) return;
    const now = this.nowSong();
    if (now - p.lastJumpReq < 0.05) return; // anti-spam
    p.lastJumpReq = now;
    if (this.state !== 'playing') { // en el lobby: salto de prueba
      if (p.t0 === null) { p.t0 = now; this.audio.jump(); p.actor.kick(-2.5); }
      return;
    }
    if (!p.alive) return;
    tPress = Math.min(now, tPress);
    if (p.t0 === null) {
      const t0 = Math.max(tPress, p.landT);
      p.t0 = t0;
      p.actor.kick(-3);
      this.audio.jump();
      if (p.pending) this.recheckPending(p);
    } else if (p.t0 + PHYS.AIR_TIME - tPress < PHYS.JUMP_BUFFER) {
      p.buffered = true;
    }
  }

  meow(p) {
    const now = performance.now();
    if (!p || now - p.lastMeow < 1000) return;
    p.lastMeow = now;
    this.cat.meow(0.9);
    this.audio.meow();
    this.fx.bubble(p.key, '¡MIAU!');
  }

  remoteInput(p, msg, client, hostNowMs) {
    if (msg.t === 'jump') {
      let delay = 0;
      if (client && typeof msg.c === 'number' && client.samples && client.samples.length) {
        const pressHost = msg.c + client.offset;
        delay = (hostNowMs - pressHost) / 1000;
        const cap = Math.min(0.2, ((client.minRtt || client.rtt || 0) / 2000) + 0.05);
        delay = Math.max(0, Math.min(cap, delay));
      }
      p.lagGrace = Math.max(0.05, Math.min(0.2, ((client && (client.minRtt || client.rtt)) || 60) / 2000 + 0.06));
      this.jump(p, this.nowSong() - delay);
    } else if (msg.t === 'meow') this.meow(p);
    else if (msg.t === 'name' && this.state === 'lobby') { p.name = cleanName(msg.name); this.saveRoster(); this.ui.refreshLobby(); }
  }

  // --------------------------------------------------------------- partida
  async setSong(buffer, name, onProgress) {
    this.audio.song = buffer;
    this.audio.songName = name;
    this.analysis = await this.audio.analyze(buffer, onProgress);
    this.chart = null;
    return this.analysis;
  }

  startMatch() {
    if (!this.analysis || this.state !== 'lobby') return false;
    if (![...this.players.values()].length) this.addBot();
    this.audio.unlock();
    this.players.forEach((p) => {
      p.waiting = false; p.alive = true; p.score = 0; p.combo = 0; p.maxCombo = 0; p.cleared = 0; p.perfects = 0; p.place = 0;
      p.t0 = null; p.landT = -99; p.buffered = false; p.pending = null; p.ko = null; p.elimT = null;
      p.actor.group.visible = true; p.actor.bodyPivot.rotation.set(0, 0, 0); p.actor.facing.rotation.x = 0; p.actor.group.scale.setScalar(1);
      p.passedSet = new Set();
    });
    this.layoutLanes();
    this.chart = generateChart(this.analysis, { difficulty: this.difficulty, seed: (Math.random() * 1e9) | 0 });
    this.layoutPlay(0, true);
    this.clearObstacles();
    this.nextEv = 0; this.revIdx = 1; this.simT = -0.5; this.warned = new Set();
    this.startCount = this.players.size;
    this.state = 'countdown';
    this.ui.onState('countdown');
    this.fx.startIris('close', 0.55, 0.5, 0.62, () => {
      this.updateCamTargets();
      this.camPos.copy(this.camTarget.pos); this.camLook.copy(this.camTarget.look);
      const d0 = dirAt(this.chart, 0);
      this.players.forEach((p) => p.actor.faceTowards(-d0, 0, true));
      this.fx.startIris('open', 0.6, 0.5, 0.5);
      this.ui.countdown(() => {
        this.state = 'playing';
        this.audio.playSong(0, 0.06);
        this.simT = this.audio.songTime();
        this.ui.onState('playing');
      });
    });
    this.updateCamTargets();
    return true;
  }

  clearObstacles() {
    this.active.forEach((o) => this.obsLayer.remove(o.mesh));
    this.active = [];
  }

  togglePause() {
    if (this.state !== 'playing') return;
    this.paused = !this.paused;
    if (this.paused) { this.audio.ctx.suspend(); } else { this.audio.ctx.resume(); }
    this.ui.pause(this.paused);
  }

  backToLobby() {
    this.audio.stopSong();
    if (this.paused) { this.paused = false; this.audio.ctx.resume(); this.ui.pause(false); }
    clearTimeout(this.endTimer);
    this.state = 'lobby';
    this.clearObstacles();
    this.players.forEach((p) => {
      p.waiting = false; p.alive = true; p.ko = null; p.t0 = null; p.pending = null;
      p.actor.group.visible = true; p.actor.bodyPivot.rotation.set(0, 0, 0); p.actor.facing.rotation.x = 0; p.actor.group.scale.setScalar(1);
      p.s = (Math.random() - 0.5) * 6;
    });
    this.layoutLanes();
    this.updateCamTargets();
    this.cat.setMood('idle', 0);
    this.ui.onState('lobby');
  }

  // --------------------------------------------------------- simulación
  obstacleS(ev, t) { return -ev.dir * ev.v * (ev.tArr - t); }

  spawnObstacles(t) {
    const ch = this.chart;
    while (this.nextEv < ch.events.length && ch.events[this.nextEv].tSpawn - 0.2 <= t) {
      const ev = ch.events[this.nextEv++];
      const mesh = buildObstacleMesh(ev, DEPTH - 0.15);
      const holder = new THREE.Group(); holder.add(mesh);
      if (this.showHitboxes) holder.add(buildHitboxMesh(ev.prims, DEPTH));
      this.obsLayer.add(holder);
      const b = profileBounds(ev.prims);
      const reach = Math.max(-b.x0, b.x1) + PHYS.PLAYER_HALF_W + 0.02;
      this.active.push({ ev, mesh: holder, inner: mesh, passed: false, passedBy: new Set(), reach, born: t, hb: this.showHitboxes });
      this.cat.tossPaw(-ev.dir);
      this.audio.spring();
    }
  }

  stepPhysics(t) {
    // pasos fijos desde simT hasta t
    let steps = 0;
    while (this.simT + PHYS.STEP <= t && steps < 400) {
      this.simT += PHYS.STEP; steps++;
      this.physicsAt(this.simT);
    }
    if (steps >= 400) this.simT = t;
  }

  feetAt(p, t) {
    if (p.t0 === null || t < p.t0) return 0;
    return jumpHeight(t - p.t0);
  }

  physicsAt(t) {
    this.players.forEach((p) => {
      if (!p.alive || p.waiting) return;
      // aterrizaje
      if (p.t0 !== null && t - p.t0 >= PHYS.AIR_TIME) {
        p.landT = p.t0 + PHYS.AIR_TIME;
        p.t0 = null;
        p.actor.kick(-2.2);
        if (p.buffered) { p.buffered = false; p.t0 = p.landT; p.actor.kick(-3); this.audio.jump(); }
      }
      if (p.isBot) this.botThink(p, t);
      // colisiones (posición relativa al jugador)
      const feet = this.feetAt(p, t);
      let hitObs = null;
      for (const o of this.active) {
        const rel = this.obstacleS(o.ev, t) - p.s;
        if (Math.abs(rel) > 3.2) continue;
        if (hitTest(rel, feet, o.ev.prims)) { hitObs = o; break; }
      }
      if (hitObs) {
        if (p.remote && p.connected) { if (!p.pending) p.pending = { t, grace: p.lagGrace || 0.08, o: hitObs }; }
        else this.eliminate(p, hitObs, t);
      }
      if (p.pending && t - p.pending.t > p.pending.grace) this.eliminate(p, p.pending.o, t);
      // obstáculos que ya me pasaron → puntaje
      for (const o of this.active) {
        if (o.passedBy.has(p.key)) continue;
        const rel = this.obstacleS(o.ev, t) - p.s;
        if (rel * o.ev.dir > o.reach) { o.passedBy.add(p.key); if (!p.pending) this.scoreObstacle(o.ev, p); }
      }
    });
  }

  recheckPending(p) {
    // ¿con el salto compensado por lag, de verdad chocó? Re-simula desde el choque hasta ahora.
    const from = p.pending.t, to = this.simT;
    for (let t = from; t <= to + 1e-9; t += PHYS.STEP) {
      const feet = this.feetAt(p, t);
      for (const o of this.active) {
        const rel = this.obstacleS(o.ev, t) - p.s;
        if (Math.abs(rel) < 3.2 && hitTest(rel, feet, o.ev.prims)) return; // sigue chocando: se mantiene el choque
      }
    }
    p.pending = null;
  }

  botThink(p, t) {
    if (p.t0 !== null) return;
    if (!p.handled) p.handled = new Set();
    const arr = (e) => e.tArr + e.dir * p.s / e.v;
    const ev = this.chart.events.find((e) => !p.handled.has(e.id) && arr(e) > t - 0.05 && arr(e) - t < 1.2);
    if (!ev) return;
    if (p.planFor !== ev.id) {
      const sigma = ev.window * (0.12 + (1 - p.skill) * 0.32) + (ev.v > 8 ? 0.01 : 0);
      const g = (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
      p.plan = arr(ev) + ev.bestTau + g * sigma;
      p.planFor = ev.id;
    }
    if (t >= p.plan) { p.handled.add(ev.id); this.jump(p, t); }
  }

  scoreObstacle(ev, p) {
    // despegue usado: el salto actual o el último
    const t0 = p.t0 !== null ? p.t0 : p.landT - PHYS.AIR_TIME;
    const myArr = ev.tArr + ev.dir * p.s / ev.v;
    const diff = Math.abs((t0 - myArr) - ev.bestTau);
    let j, mult, color, text;
    if (diff <= Math.max(0.035, ev.window * 0.2)) { j = 'perfect'; mult = 3; color = PAL.yellow; text = '¡PERFECTO!'; p.perfects++; }
    else if (diff <= ev.window * 0.4) { j = 'great'; mult = 2; color = '#7cf2ff'; text = '¡GENIAL!'; }
    else { j = 'ok'; mult = 1; color = PAL.white; text = 'BIEN'; }
    p.combo++; p.maxCombo = Math.max(p.maxCombo, p.combo); p.cleared++;
    const gain = Math.round(100 * mult * (1 + Math.min(p.combo, 30) * 0.1));
    p.score += gain;
    const head = p.actor.group.position.clone(); head.y += CHAR_HEIGHT + 0.5;
    if (!p.isBot || this.players.size <= 2) this.fx.popup(text, head, color, j === 'perfect' ? 0.95 : 0.75);
    if (j === 'perfect' && !p.isBot) this.audio.perfect();
    this.ui.sendTo(p, { t: 'judge', j, combo: p.combo, score: p.score });
  }

  eliminate(p, o, t) {
    if (!p.alive) return;
    p.alive = false; p.pending = null; p.combo = 0;
    p.elimT = t;
    const alive = [...this.players.values()].filter((q) => q.alive && !q.waiting).length;
    p.place = alive + 1;
    const dir = o ? o.ev.dir : 1;
    p.ko = { vx: dir * 7, vy: 13, vz: 5, t: 0 };
    p.actor.kick(4);
    this.audio.hit();
    const pos = p.actor.group.position.clone(); pos.y += 1.2;
    this.fx.poof(pos, 1.2); this.fx.koStars(pos);
    this.fx.popup('¡K.O.!', pos, PAL.red, 1.3);
    this.cat.setMood('surprised', 0.5); this.cat.meow(0.4);
    this.ui.toast(`💥 ¡${p.name} quedó fuera!`);
    this.ui.sendTo(p, { t: 'ko', place: p.place, score: p.score });
    this.checkEnd(t);
  }

  checkEnd(t) {
    if (this.state !== 'playing' || this.endTimer) return;
    const inGame = [...this.players.values()].filter((p) => !p.waiting);
    const alive = inGame.filter((p) => p.alive);
    const songOver = t >= this.chart.duration - 0.25;
    if (songOver || alive.length === 0 || (this.startCount > 1 && alive.length <= 1)) {
      this.endTimer = setTimeout(() => { this.endTimer = null; this.finish(); }, songOver ? 300 : 1800);
    }
  }

  finish() {
    if (this.state !== 'playing') return;
    this.state = 'results';
    this.audio.stopSong();
    this.audio.fanfare();
    const inGame = [...this.players.values()].filter((p) => !p.waiting);
    // orden: vivos por puntaje, luego eliminados por momento de eliminación (más tarde = mejor) y puntaje
    inGame.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (!a.alive && a.elimT !== b.elimT) return (b.elimT || 0) - (a.elimT || 0);
      return b.score - a.score;
    });
    inGame.forEach((p, i) => { p.place = i + 1; });
    this.cat.meow(1);
    this.ui.onState('results', inGame);
    inGame.forEach((p) => this.ui.sendTo(p, { t: 'state', phase: 'results', place: p.place, total: inGame.length, score: p.score, alive: p.alive }));
  }

  // ------------------------------------------------------------ bucle
  loop(nowMs) {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;
    if (this.paused) { this.render(0); return; }
    if (this.state !== 'playing') this.lobbyClock += dt;

    const t = this.state === 'playing' ? this.audio.songTime() : this.lobbyClock;
    this.t = t;
    const beat = this.beatInfo(t);
    this.beat = beat;

    if (this.state === 'playing') {
      this.spawnObstacles(t);
      this.stepPhysics(t);
      this.handleReversals(t);
      this.checkEnd(t);
      this.ui.hud(t, this.chart, this.players);
    } else {
      if (this.state === 'countdown' && this.chart) this.ui.hud(0, this.chart, this.players);
      // salto de prueba en el lobby
      this.players.forEach((p) => { if (p.t0 !== null && t - p.t0 >= PHYS.AIR_TIME) { p.t0 = null; p.actor.kick(-2); } });
    }
    this.updateObstacles(t, dt);
    this.updateActors(t, dt, beat);

    // cámara suave
    this.camPos.lerp(this.camTarget.pos, Math.min(1, dt * 3));
    this.camLook.lerp(this.camTarget.look, Math.min(1, dt * 3));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    // gato
    if (this.state === 'playing') this.lastSongT = t;
    const dir = this.chart && this.state !== 'lobby' ? dirAt(this.chart, this.state === 'playing' ? t : (this.state === 'results' ? (this.lastSongT || 0) : 0)) : 1;
    let look, spin;
    if (this.state === 'playing' || this.state === 'results') {
      const incoming = this.active.filter((o) => !o.passed).sort((a, b) => a.ev.tArr - b.ev.tArr)[0];
      look = incoming ? Math.max(-1, Math.min(1, this.obstacleS(incoming.ev, t) / (R * 0.9))) : -dir * 0.6;
      const vNow = incoming ? incoming.ev.v : (this.chart ? this.chart.events[Math.min(this.nextEv, this.chart.events.length - 1)]?.v || 6 : 6);
      spin = this.state === 'playing' ? dir * vNow / R : 0.05;
    } else { look = undefined; spin = 0.12; }
    this.spinSpeed += (spin - this.spinSpeed) * Math.min(1, dt * 4);
    this.dir = dir;
    this.cat.update(dt, { beat: beat.phase, beatIndex: beat.index, look, spinSpeed: this.spinSpeed, lookY: 0 });
    this.render(dt);
  }

  handleReversals(t) {
    const ch = this.chart;
    for (let i = 1; i < ch.reversals.length; i++) {
      const r = ch.reversals[i];
      const warnT = r.t - 2 * ch.beatDur;
      if (t >= warnT && !this.warned.has(i)) {
        this.warned.add(i);
        this.ui.reversal(r.dir);
        this.cat.meow(1); this.audio.meow(0.8);
        this.cat.setMood('surprised', 1.0);
      }
      if (t >= r.t && !this.warned.has('done' + i)) {
        this.warned.add('done' + i);
        this.audio.screech();
        // los que ya pasaron se van en una nube
        this.active.forEach((o) => { o.kill = true; });
        this.layoutPlay(t);
      }
    }
  }

  updateObstacles(t, dt) {
    if (!this.chart) return;
    const keep = [];
    for (const o of this.active) {
      const ev = o.ev;
      const s = this.state === 'playing' ? this.obstacleS(ev, t) : this.obstacleS(ev, o.lastT || t);
      if (this.state === 'playing') o.lastT = t;
      o.passed = s * ev.dir > 0;
      const phi = s / R;
      o.mesh.position.set(R * Math.sin(phi), R * Math.cos(phi), 0);
      o.mesh.rotation.z = -phi;
      // aparición con rebote
      const age = t - (ev.tSpawn - 0.2);
      const k = Math.min(1, Math.max(0, age / 0.32));
      const pop = k < 1 ? (1 - Math.pow(1 - k, 3)) * (1 + Math.sin(k * Math.PI) * 0.35) : 1;
      o.inner.scale.set(1, Math.max(0.01, pop), 1);
      // rodar troncos/ovillos
      if (o.inner.userData.spin && (ev.kind === 'log' || ev.kind === 'yarn' || ev.kind === 'bomb')) {
        const r = ev.w / 2; o.inner.userData.spin.rotation.z = -(s / r) * 0.5;
      }
      if (this.showHitboxes !== o.hb) {
        o.hb = this.showHitboxes;
        if (o.hb) o.mesh.add(buildHitboxMesh(ev.prims, DEPTH)); else o.mesh.children.slice(1).forEach((c) => o.mesh.remove(c));
      }
      const gone = s * ev.dir > PHYS.EXIT_ARC * R || o.kill;
      if (gone && this.state === 'playing') {
        this.obsLayer.remove(o.mesh);
        const wp = o.mesh.position.clone(); wp.y += ev.h / 2;
        this.fx.poof(wp, 0.9);
        continue;
      }
      keep.push(o);
    }
    this.active = keep;
  }

  updateActors(t, dt, beat) {
    const playing = this.state === 'playing' || this.state === 'countdown' || this.state === 'results';
    const dir = this.chart && playing ? dirAt(this.chart, this.state === 'playing' ? Math.max(0, t) : (this.state === 'results' ? (this.lastSongT || 0) : 0)) : 1;
    const v = this.spinSpeed * R;
    this.players.forEach((p) => {
      const a = p.actor;
      if (p.waiting) { a.group.visible = false; return; }
      if (p.ko) {
        p.ko.t += dt;
        p.ko.vy -= 30 * dt;
        a.group.position.x += p.ko.vx * dt; a.group.position.y += p.ko.vy * dt; a.group.position.z += p.ko.vz * dt;
        a.update(dt, { mode: 'ko' });
        if (p.ko.t > 1.6) a.group.visible = false;
        return;
      }
      let s, z = p.lane, air = 0, mode;
      if (playing) {
        if (p.targetS !== undefined && p.alive) {
          const d = p.targetS - p.s;
          p.s += Math.sign(d) * Math.min(Math.abs(d), dt * 5);
        }
        s = p.s;
        air = this.state === 'playing' ? this.feetAt(p, t) : 0;
        if (this.state === 'results') mode = p.alive ? 'idle' : 'ko';
        else if (this.state === 'countdown') mode = 'idle';
        else mode = air > 0 ? 'jump' : 'run';
        a.faceTowards(-dir, dt);
      } else {
        // lobby: pasean por la cabeza y bailan
        if (p.t0 !== null) air = jumpHeight(t - p.t0);
        p.walkPause -= dt;
        if (p.walkPause <= 0 && Math.abs(p.s - p.walkTarget) < 0.05) {
          p.walkTarget = (Math.random() - 0.5) * 7; p.walkPause = 1.5 + Math.random() * 3;
        }
        const d = p.walkTarget - p.s;
        if (Math.abs(d) > 0.05 && p.walkPause < 1.2) {
          const step = Math.sign(d) * Math.min(Math.abs(d), dt * 1.6);
          p.s += step; mode = 'walk'; a.faceTowards(Math.sign(d), dt);
        } else { mode = 'idle'; a.faceTowards(p.s > 0 ? -1 : 1, dt); }
        if (air > 0) mode = 'jump';
        s = p.s;
      }
      const phi = s / R;
      const rr = R + 0.02 + air;
      a.group.position.set(Math.sin(phi) * rr, Math.cos(phi) * rr, z);
      a.group.rotation.z = -phi;
      a.ground.position.y = -air; // sombra se queda en el suelo
      a.ground.scale.setScalar(Math.max(0.4, 1 - air * 0.18));
      const vyUp = p.t0 !== null ? (t - p.t0) < PHYS.AIR_TIME / 2 : false;
      a.update(dt, { mode, speed: Math.abs(v), vyUp, beat: beat.phase, beatIndex: beat.index + (p.key.length % 2) });
      if (p.pending) a.group.position.x += (Math.random() - 0.5) * 0.02;
    });
  }

  render(dt) {
    // fondo 2D (orejas, brazos) proyectado
    const ctx = this.bg;
    ctx.setTransform(this.bgDpr, 0, 0, this.bgDpr, 0, 0);
    this.camera.updateMatrixWorld();
    this.cat.drawBackdrop(ctx, this.W, this.H, (x, y, z) => this.project(x, y, z), { beat: this.beat ? this.beat.phase : 0, beatIndex: this.beat ? this.beat.index : 0, dir: this.dir });
    this.renderer.render(this.scene, this.camera);
    // placas de nombre
    const plates = [];
    this.players.forEach((p) => {
      if (p.waiting || !p.actor.group.visible || p.ko) return;
      const gp = p.actor.group.position;
      const up = new THREE.Vector3(Math.sin(-p.actor.group.rotation.z), Math.cos(p.actor.group.rotation.z), 0);
      const top = gp.clone().addScaledVector(up, CHAR_HEIGHT + 0.15);
      const head = this.project(top.x, top.y, top.z);
      plates.push({ id: p.key, name: p.name, color: p.color, head, alive: p.alive, connected: p.connected || !p.remote });
    });
    this.fx.draw(dt, (x, y, z) => this.project(x, y, z), plates);
  }
}
