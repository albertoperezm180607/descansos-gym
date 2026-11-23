'use strict';

/* =====================================================================
   MOTOR — lógica pura de la sesión (sin DOM). Todas las funciones
   reciben `now` (ms) y devuelven un estado NUEVO: así se pueden probar
   simulando el paso del tiempo (ver tests/).

   El descanso se guarda como una hora de fin absoluta (rest.end).
   Lo que queda siempre es rest.end - Date.now(): no se acumula nada
   en intervalos, así que bloquear la pantalla no desfasa el contador.
   ===================================================================== */
const GymEngine = (() => {
  const DEF_REST_SET = 90;
  const DEF_REST_EX = 120;

  const secs = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : def;
  };

  const posInt = v => Math.max(1, Math.round(Number(v)) || 1);

  const normExercise = (e, j) => ({
    nombre: e && e.nombre ? String(e.nombre) : `Ejercicio ${j + 1}`,
    series: posInt(e && e.series),
    reps: e && e.reps != null ? String(e.reps) : '',
    peso: e && e.peso != null ? String(e.peso) : '',
    descanso_serie: secs(e && e.descanso_serie, DEF_REST_SET),
    descanso_tras_ejercicio: secs(e && e.descanso_tras_ejercicio, DEF_REST_EX),
  });

  /*
   Un día es una lista de ejercicios normales y/o circuitos:
     { "circuito": "Nombre", "vueltas": 3, "descanso_entre_ejercicios": 30,
       "descanso_entre_vueltas": 120, "descanso_tras_circuito": 120,
       "ejercicios": [ { "nombre", "reps", "peso" }, ... ] }
   Un circuito se "despliega" en pasos de 1 serie (vuelta 1: A, B, C; vuelta 2: A, B, C…),
   así el motor no necesita saber nada de circuitos.
   `orden` = nº de ejercicio distinto (para "Ejercicio 3/6" y el resumen).
  */
  function normalizeRoutine(raw) {
    if (!raw || !Array.isArray(raw.dias)) throw new Error('routine.json debe tener una lista "dias"');
    const dias = raw.dias
      .map((d, i) => {
        const ejercicios = [];
        let orden = 0;
        (d && Array.isArray(d.ejercicios) ? d.ejercicios : []).forEach((item, j) => {
          if (item && Array.isArray(item.ejercicios)) {
            const subs = item.ejercicios.map((e, k) => ({ base: normExercise(e, k), orden: ++orden }));
            if (!subs.length) return;
            const vueltas = posInt(item.vueltas);
            const entre = secs(item.descanso_entre_ejercicios, 0);
            const entreVueltas = secs(item.descanso_entre_vueltas, DEF_REST_EX);
            const tras = secs(item.descanso_tras_circuito, entreVueltas);
            const circuito = item.circuito ? String(item.circuito) : 'Circuito';
            for (let v = 1; v <= vueltas; v++) {
              subs.forEach((s, k) => {
                const finVuelta = k === subs.length - 1;
                ejercicios.push({
                  ...s.base, series: 1, descanso_serie: 0,
                  descanso_tras_ejercicio: !finVuelta ? entre : v < vueltas ? entreVueltas : tras,
                  orden: s.orden, circuito, vuelta: v, vueltas,
                });
              });
            }
          } else {
            ejercicios.push({ ...normExercise(item, j), orden: ++orden });
          }
        });
        return { nombre: d && d.nombre ? String(d.nombre) : `Día ${i + 1}`, ejercicios, numEjercicios: orden };
      })
      .filter(d => d.ejercicios.length > 0);
    if (!dias.length) throw new Error('routine.json no tiene ningún día con ejercicios');
    return { dias };
  }

  const exercisesOf = (routine, day) => routine.dias[day].ejercicios;

  /** Posición de la serie que viene después de (ex, set), o null si era la última del día. */
  function nextPosition(routine, day, ex, set) {
    const list = exercisesOf(routine, day);
    if (set + 1 < list[ex].series) return { ex, set: set + 1 };
    if (ex + 1 < list.length) return { ex: ex + 1, set: 0 };
    return null;
  }

  /** Segundos de descanso tras terminar la serie (ex, set). */
  function restAfter(routine, day, ex, set) {
    const e = exercisesOf(routine, day)[ex];
    return set + 1 < e.series ? e.descanso_serie : e.descanso_tras_ejercicio;
  }

  const totalSets = (routine, day) => exercisesOf(routine, day).reduce((n, e) => n + e.series, 0);

  /*
   Estado de sesión:
   { v, day, dayName,
     ex, set        → serie que toca hacer (durante el descanso: la SIGUIENTE)
     phase          → 'work' | 'rest' | 'done'
     rest           → { start, end, total, paused } | null   (ms; paused = ms restantes congelados)
     alarm, alarmAt → la alarma está sonando y desde cuándo
     log            → [{ ex, set, at }] series completadas
     startedAt, finishedAt }
  */
  function createSession(routine, day, now) {
    return {
      v: 1, day, dayName: routine.dias[day].nombre,
      ex: 0, set: 0, phase: 'work', rest: null,
      alarm: false, alarmAt: null, log: [],
      startedAt: now, finishedAt: null,
    };
  }

  function isValidSession(s, routine) {
    if (!s || s.v !== 1 || !routine || !Array.isArray(routine.dias)) return false;
    const d = routine.dias[s.day];
    if (!d || d.nombre !== s.dayName) return false;
    const e = d.ejercicios[s.ex];
    if (!e || !Number.isInteger(s.set) || s.set < 0 || s.set >= e.series) return false;
    if (!['work', 'rest', 'done'].includes(s.phase) || !Array.isArray(s.log)) return false;
    if (!s.log.every(l => d.ejercicios[l.ex] && l.set >= 0 && l.set < d.ejercicios[l.ex].series)) return false;
    if (s.phase === 'rest' && !(s.rest && Number.isFinite(s.rest.end) && Number.isFinite(s.rest.total))) return false;
    return Number.isFinite(s.startedAt);
  }

  /** Marca como hecha la serie actual y arranca el descanso que toque (o termina el día). */
  function completeSet(s, routine, now) {
    if (s.phase !== 'work') return s;
    const log = s.log.concat([{ ex: s.ex, set: s.set, at: now }]);
    const base = { ...s, log, alarm: false, alarmAt: null };
    const next = nextPosition(routine, s.day, s.ex, s.set);
    if (!next) return { ...base, phase: 'done', rest: null, finishedAt: now };
    const dur = restAfter(routine, s.day, s.ex, s.set) * 1000;
    if (dur <= 0) return { ...base, ex: next.ex, set: next.set, phase: 'work', rest: null };
    return {
      ...base, ex: next.ex, set: next.set, phase: 'rest',
      rest: { start: now, end: now + dur, total: dur, paused: null },
    };
  }

  /** ms que quedan de descanso. */
  function remaining(s, now) {
    if (s.phase !== 'rest' || !s.rest) return 0;
    if (s.rest.paused != null) return Math.max(0, s.rest.paused);
    return Math.max(0, s.rest.end - now);
  }

  /** Fracción transcurrida del descanso (0 → 1), para el anillo. */
  function progress(s, now) {
    if (s.phase !== 'rest' || !s.rest) return 0;
    const total = s.rest.total;
    if (!(total > 0)) return 1;
    return Math.min(1, Math.max(0, 1 - remaining(s, now) / total));
  }

  /** Si el descanso ya terminó, pasa a la siguiente serie con la alarma sonando. */
  function tick(s, now) {
    if (s.phase === 'rest' && s.rest && s.rest.paused == null && now >= s.rest.end) {
      return { ...s, phase: 'work', rest: null, alarm: true, alarmAt: s.rest.end };
    }
    return s;
  }

  /** Suma/resta segundos al descanso en curso (también si está en pausa). */
  function adjust(s, deltaSec, now) {
    s = tick(s, now);
    if (s.phase !== 'rest' || !s.rest) return s;
    const r = s.rest;
    const rem = remaining(s, now);
    const newRem = Math.max(0, rem + deltaSec * 1000);
    const total = Math.max(0, r.total + (newRem - rem)); // = transcurrido + lo que queda
    if (r.paused != null) {
      if (newRem === 0) return tick({ ...s, rest: { ...r, paused: null, end: now, total } }, now);
      return { ...s, rest: { ...r, paused: newRem, total } };
    }
    return tick({ ...s, rest: { ...r, end: now + newRem, total } }, now);
  }

  function togglePause(s, now) {
    s = tick(s, now);
    if (s.phase !== 'rest' || !s.rest) return s;
    const r = s.rest;
    if (r.paused == null) return { ...s, rest: { ...r, paused: Math.max(0, r.end - now) } };
    return tick({ ...s, rest: { ...r, end: now + r.paused, paused: null } }, now);
  }

  /** Salta el descanso: directo a la siguiente serie, sin alarma. */
  function skip(s) {
    if (s.phase !== 'rest') return s;
    return { ...s, phase: 'work', rest: null, alarm: false, alarmAt: null };
  }

  function stopAlarm(s) {
    if (!s.alarm) return s;
    return { ...s, alarm: false, alarmAt: null };
  }

  /** Vuelve atrás una serie: deshace la última serie marcada como hecha. */
  function undo(s) {
    if (!s.log.length) return s;
    const last = s.log[s.log.length - 1];
    return {
      ...s, log: s.log.slice(0, -1), ex: last.ex, set: last.set,
      phase: 'work', rest: null, alarm: false, alarmAt: null, finishedAt: null,
    };
  }

  function summary(s, routine, now) {
    const list = exercisesOf(routine, s.day);
    const done = list.map(() => 0);
    s.log.forEach(l => { if (done[l.ex] != null) done[l.ex]++; });
    // Agrupa por ejercicio distinto (las vueltas de un circuito cuentan como series)
    const groups = [];
    const byKey = new Map();
    list.forEach((e, i) => {
      const key = e.orden != null ? e.orden : `i${i}`;
      let g = byKey.get(key);
      if (!g) {
        g = { nombre: e.nombre, hechas: 0, series: 0, reps: e.reps, peso: e.peso };
        byKey.set(key, g);
        groups.push(g);
      }
      g.hechas += done[i];
      g.series += e.series;
    });
    return {
      dayName: s.dayName,
      durationMs: (s.finishedAt || now) - s.startedAt,
      setsDone: s.log.length,
      setsTotal: totalSets(routine, s.day),
      exercises: groups,
    };
  }

  return {
    normalizeRoutine, nextPosition, restAfter, totalSets, createSession, isValidSession,
    completeSet, remaining, progress, tick, adjust, togglePause, skip, stopAlarm, undo, summary,
  };
})();

/* =====================================================================
   APP — interfaz, sonido, vibración, notificaciones y wake lock
   ===================================================================== */
function initApp() {
  const E = GymEngine;
  const LS_SESSION = 'descansos.session.v1';
  const LS_LASTDAY = 'descansos.lastDay.v1';
  const SESSION_STALE_MS = 6 * 60 * 60 * 1000; // sesión sin actividad en 6 h → se descarta
  const ALARM_STALE_MS = 10 * 60 * 1000;       // alarma de hace >10 min al reabrir → no suena
  const DONE_KEEP_MS = 60 * 60 * 1000;         // el resumen se sigue viendo 1 h tras terminar
  const INPUT_LOCK_MS = 650;                   // evita dobles toques al cambiar de pantalla
  const RING_C = 2 * Math.PI * 90;

  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio / modo privado */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
  };

  let routine = null;
  let loadError = null;
  let state = null;
  let lockUntil = 0;
  let endTimer = null;

  /* ---------- Sonido (Web Audio) ----------
     La alarma se PROGRAMA en el reloj de audio para la hora de fin del
     descanso. Así suena aunque el navegador ralentice los timers de JS
     (pantalla bloqueada / otra app en Android). En primer plano se
     va alargando hasta que la paras. */
  const Sound = {
    ctx: null, master: null, nodes: [], plannedAt: null, until: 0, primed: false,
    CYCLE: 1.25,
    get ready() { return !!this.ctx && this.ctx.state === 'running'; },

    unlock() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) {
        try { this.ctx = new AC(); } catch { return; }
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
        this.ctx.onstatechange = () => {
          if (this.ctx.state === 'running') { this.cancel(); syncEffects(); }
          renderSoundHint();
        };
      }
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      if (!this.primed) { // buffer silencioso: lo que realmente "desbloquea" iOS
        try {
          const src = this.ctx.createBufferSource();
          src.buffer = this.ctx.createBuffer(1, 1, 22050);
          src.connect(this.ctx.destination);
          src.start(0);
          this.primed = true;
        } catch { /* nada */ }
      }
    },

    beep(t, freq, dur) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
      g.gain.setValueAtTime(0.5, t + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      const node = { osc, g };
      this.nodes.push(node);
      osc.onended = () => {
        const i = this.nodes.indexOf(node);
        if (i >= 0) this.nodes.splice(i, 1);
        try { g.disconnect(); } catch { /* ya desconectado */ }
      };
    },

    cycle(t) { // "bip-bip-biiip"
      this.beep(t, 1050, 0.13);
      this.beep(t + 0.19, 1050, 0.13);
      this.beep(t + 0.38, 1400, 0.22);
    },

    fill(toCtxTime) {
      const now = this.ctx.currentTime;
      if (this.until < now) this.until = now + 0.05; // nunca programar en el pasado (ráfaga)
      while (this.until < toCtxTime) { this.cycle(this.until); this.until += this.CYCLE; }
    },

    /** Programa la alarma para que empiece a la hora de reloj `wallMs` (puede ser futura). */
    planAt(wallMs) {
      if (!this.ready) return;
      if (this.plannedAt !== null && Math.abs(this.plannedAt - wallMs) < 120) return;
      this.cancel();
      this.plannedAt = wallMs;
      const now = this.ctx.currentTime;
      this.until = Math.max(now + 0.05, now + (wallMs - Date.now()) / 1000);
      this.fill(this.until + 30);
    },

    keepRinging() {
      if (!this.ready) return;
      if (this.plannedAt === null) { this.planAt(Date.now()); return; }
      if (this.until < this.ctx.currentTime + 8) this.fill(this.ctx.currentTime + 20);
    },

    cancel() {
      const ns = this.nodes;
      this.nodes = [];
      ns.forEach(({ osc, g }) => {
        try { osc.stop(); } catch { /* ya parado */ }
        try { g.disconnect(); } catch { /* idem */ }
      });
      this.plannedAt = null;
      this.until = 0;
    },

    test() {
      this.unlock();
      const play = () => { if (this.ready) this.cycle(this.ctx.currentTime + 0.05); };
      if (this.ready) play(); else setTimeout(play, 200);
    },
  };

  /* ---------- Vibración + notificación ---------- */
  const VIB = [450, 200, 450, 200, 450];
  const vibrate = () => { try { if (navigator.vibrate) navigator.vibrate(VIB); } catch { /* no soportado */ } };

  async function swRegistration() {
    try { return navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null; } catch { return null; }
  }

  async function notify() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const body = state ? `${currentExercise().nombre} – ${setMeta(currentExercise(), state.set)}` : '';
    const opts = {
      body, tag: 'descanso', renotify: true, requireInteraction: true,
      vibrate: VIB, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    };
    const reg = await swRegistration();
    try {
      if (reg) await reg.showNotification('¡Descanso terminado!', opts);
      else new Notification('¡Descanso terminado!', opts);
    } catch { /* sin notificación */ }
  }

  async function closeNotifications() {
    const reg = await swRegistration();
    try { (reg ? await reg.getNotifications({ tag: 'descanso' }) : []).forEach(n => n.close()); } catch { /* nada */ }
  }

  function askNotifications() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    try {
      const p = Notification.requestPermission(renderNotifBtn);
      if (p && p.then) p.then(renderNotifBtn).catch(() => {});
    } catch { /* nada */ }
  }

  const Alarm = {
    active: false, timer: null,
    on() {
      if (this.active) return;
      this.active = true;
      const dlg = $('confirm-exit');
      if (dlg.open) dlg.close(); // que el diálogo no tape la alarma
      vibrate();
      this.timer = setInterval(vibrate, 1800);
      if (document.visibilityState !== 'visible') notify();
    },
    off() {
      if (!this.active) return;
      this.active = false;
      clearInterval(this.timer);
      try { if (navigator.vibrate) navigator.vibrate(0); } catch { /* nada */ }
      closeNotifications();
    },
  };

  /* ---------- Screen Wake Lock ---------- */
  const wantWake = () => !!state && state.phase !== 'done';
  const Wake = {
    sentinel: null, pending: false,
    async on() {
      if (!('wakeLock' in navigator) || this.sentinel || this.pending || document.visibilityState !== 'visible') return;
      this.pending = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        this.sentinel = s;
        s.addEventListener('release', () => { if (this.sentinel === s) this.sentinel = null; });
      } catch { /* denegado o no disponible */ }
      this.pending = false;
      if (!wantWake()) this.off();
    },
    off() {
      const s = this.sentinel;
      this.sentinel = null;
      if (s) s.release().catch(() => {});
    },
  };

  /* ---------- Estado ---------- */
  const currentExercise = () => routine.dias[state.day].ejercicios[state.ex];

  function setState(next) {
    const prev = state;
    state = next;
    if (state) store.set(LS_SESSION, state); else store.del(LS_SESSION);
    const changed = !prev || !next || prev.phase !== next.phase || prev.alarm !== next.alarm
      || prev.ex !== next.ex || prev.set !== next.set; // también al pasar de ejercicio sin descanso
    if (changed) lockUntil = Date.now() + INPUT_LOCK_MS;
    syncEffects();
    render();
  }

  /** Pone sonido, timers, vibración y wake lock de acuerdo con el estado actual (idempotente). */
  function syncEffects() {
    clearTimeout(endTimer);
    endTimer = null;
    const s = state;
    const resting = !!s && s.phase === 'rest' && !!s.rest && s.rest.paused == null;
    if (resting) endTimer = setTimeout(tick, Math.max(0, s.rest.end - Date.now()) + 20);
    if (s && s.alarm) { Alarm.on(); Sound.keepRinging(); }
    else { Alarm.off(); if (resting) Sound.planAt(s.rest.end); else Sound.cancel(); }
    if (wantWake()) Wake.on(); else Wake.off();
  }

  function tick() {
    if (!state) return;
    const next = E.tick(state, Date.now());
    if (next !== state) setState(next);
    else if (state.alarm) Sound.keepRinging();
    renderTimer();
  }

  /* ---------- Formato ---------- */
  const fmt = ms => {
    const t = Math.ceil(Math.max(0, ms) / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const fmtDuration = ms => {
    const min = Math.round(ms / 60000);
    if (min < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
  };
  const clock = ms => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const isNumReps = r => /^[\d\s\-–x×/]+$/.test(r);
  const repsText = r => (r && isNumReps(r) ? `${r} reps` : r);
  const setLabel = (e, set) => (e.vueltas ? `Vuelta ${e.vuelta}/${e.vueltas}` : `Serie ${set + 1}/${e.series}`);
  const setMeta = (e, set) => [setLabel(e, set), repsText(e.reps), e.peso].filter(Boolean).join(' – ');

  /* ---------- Render ---------- */
  const show = (el, visible) => { el.hidden = !visible; };

  function render() {
    const s = state;
    const screen = !routine || !s ? 'days' : s.phase === 'done' ? 'done' : 'session';
    show($('screen-days'), screen === 'days');
    show($('screen-session'), screen === 'session');
    show($('screen-done'), screen === 'done');
    show($('alarm'), !!s && s.alarm);
    document.body.dataset.phase = !s ? 'days' : s.alarm ? 'alarm' : s.phase;
    if (screen === 'days') renderDays();
    else if (screen === 'session') renderSession();
    else renderDone();
    if (s && s.alarm) renderAlarm();
    renderSoundHint();
  }

  function renderDays() {
    const ul = $('day-list');
    ul.textContent = '';
    show($('load-error'), !!loadError);
    if (loadError) $('load-error-msg').textContent = loadError;
    if (!routine) return;
    const last = store.get(LS_LASTDAY);
    let lastIdx = last ? routine.dias.findIndex(d => d.nombre === last.name) : -1;
    if (lastIdx < 0 && last && routine.dias[last.index]) lastIdx = last.index;
    routine.dias.forEach((d, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-btn' + (i === lastIdx ? ' is-last' : '');
      const name = document.createElement('span');
      name.className = 'day-name';
      name.textContent = d.nombre;
      const meta = document.createElement('span');
      meta.className = 'day-meta';
      meta.textContent = `${d.numEjercicios || d.ejercicios.length} ejercicios · ${E.totalSets(routine, i)} series`;
      b.append(name, meta);
      if (i === lastIdx) {
        const tag = document.createElement('span');
        tag.className = 'day-tag';
        tag.textContent = 'Último';
        b.append(tag);
      }
      b.addEventListener('click', act(() => startDay(i)));
      li.append(b);
      ul.append(li);
    });
    renderNotifBtn();
  }

  function renderNotifBtn() {
    const b = $('btn-notif');
    if (!('Notification' in window)) { b.hidden = true; return; }
    const p = Notification.permission;
    b.hidden = false;
    b.disabled = p !== 'default';
    b.textContent = p === 'granted' ? 'Avisos activados ✓' : p === 'denied' ? 'Avisos bloqueados' : 'Activar avisos';
  }

  function renderSoundHint() {
    show($('sound-hint'), !!state && state.phase !== 'done' && !Sound.ready);
  }

  function renderSession() {
    const s = state;
    const day = routine.dias[s.day];
    const list = day.ejercicios;
    const e = list[s.ex];
    const circ = !!e.vueltas;
    const resting = s.phase === 'rest';
    $('day-name').textContent = s.dayName;
    $('ex-count').textContent = `Ejercicio ${e.orden || s.ex + 1}/${day.numEjercicios || list.length}`;
    $('btn-undo').disabled = s.log.length === 0;
    show($('view-work'), !resting);
    show($('view-rest'), resting);

    if (!resting) {
      show($('w-tag'), circ);
      if (circ) $('w-tag').textContent = e.circuito;
      $('w-ex-name').textContent = e.nombre;
      $('w-set-word').textContent = circ ? 'Vuelta' : 'Serie';
      $('w-set').textContent = circ ? `${e.vuelta}/${e.vueltas}` : `${s.set + 1}/${e.series}`;
      $('w-reps').textContent = e.reps || '—';
      $('w-reps-lab').textContent = !e.reps || isNumReps(e.reps) ? 'reps' : 'objetivo';
      $('w-peso').textContent = e.peso || '—';
      const dots = $('w-dots');
      dots.textContent = '';
      const n = circ ? e.vueltas : e.series;
      const cur = circ ? e.vuelta - 1 : s.set;
      for (let i = 0; i < n; i++) {
        const d = document.createElement('i');
        d.className = i < cur ? 'done' : i === cur ? 'now' : '';
        dots.append(d);
      }
      const nxt = E.nextPosition(routine, s.day, s.ex, s.set);
      const restS = E.restAfter(routine, s.day, s.ex, s.set);
      $('w-after').textContent = !nxt ? 'Última serie del día' : restS > 0 ? `Después: descanso ${fmt(restS * 1000)}` : 'Después: sin descanso';
    } else {
      $('r-next-name').textContent = e.nombre;
      $('r-next-meta').textContent = setMeta(e, s.set);
      $('r-new-ex').textContent = circ ? e.circuito : 'Nuevo ejercicio';
      show($('r-new-ex'), circ || s.set === 0);
      $('btn-pause').textContent = s.rest.paused != null ? 'Reanudar' : 'Pausar';
      renderTimer();
    }
  }

  function renderTimer() {
    const s = state;
    if (!s || s.phase !== 'rest' || !s.rest) return;
    const now = Date.now();
    const rem = E.remaining(s, now);
    const txt = fmt(rem);
    const t = $('r-time');
    if (t.textContent !== txt) t.textContent = txt;
    $('ring-fg').style.strokeDashoffset = String(RING_C * E.progress(s, now));
    const v = $('view-rest');
    v.classList.toggle('is-paused', s.rest.paused != null);
    v.classList.toggle('is-urgent', s.rest.paused == null && rem <= 10000);
  }

  function renderAlarm() {
    const e = currentExercise();
    $('a-name').textContent = e.nombre;
    $('a-meta').textContent = setMeta(e, state.set);
  }

  function renderDone() {
    const sum = E.summary(state, routine, Date.now());
    $('d-day').textContent = sum.dayName;
    $('d-time').textContent = fmtDuration(sum.durationMs);
    $('d-sets').textContent = `${sum.setsDone}/${sum.setsTotal}`;
    $('d-exs').textContent = String(sum.exercises.length);
    $('d-range').textContent = `${clock(state.startedAt)} – ${clock(state.finishedAt || Date.now())}`;
    const ul = $('d-list');
    ul.textContent = '';
    sum.exercises.forEach(x => {
      const li = document.createElement('li');
      const ok = x.hechas >= x.series;
      li.className = ok ? 'ok' : 'partial';
      const n = document.createElement('span');
      n.className = 'd-ex';
      n.textContent = x.nombre;
      const m = document.createElement('span');
      m.className = 'd-meta';
      m.textContent = `${x.hechas}/${x.series} × ${x.reps || '—'}${x.peso ? ' · ' + x.peso : ''}`;
      li.append(n, m);
      ul.append(li);
    });
  }

  /* ---------- Acciones ---------- */
  const act = fn => ev => {
    if (ev) ev.preventDefault();
    if (Date.now() < lockUntil) return;
    Sound.unlock();
    fn();
  };

  function startDay(i) {
    askNotifications();
    store.set(LS_LASTDAY, { index: i, name: routine.dias[i].nombre });
    setState(E.createSession(routine, i, Date.now()));
  }

  function exitSession() {
    const dlg = $('confirm-exit');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else if (window.confirm('¿Salir de la sesión? Se perderá el progreso de hoy.')) setState(null);
  }

  function bind() {
    const on = (id, fn) => $(id).addEventListener('click', act(fn));
    on('btn-done', () => setState(E.completeSet(state, routine, Date.now())));
    on('btn-plus', () => setState(E.adjust(state, 15, Date.now())));
    on('btn-minus', () => setState(E.adjust(state, -15, Date.now())));
    on('btn-pause', () => setState(E.togglePause(state, Date.now())));
    on('btn-skip', () => setState(E.skip(state)));
    on('btn-undo', () => setState(E.undo(state)));
    on('alarm', () => setState(E.stopAlarm(state)));
    on('btn-exit', exitSession);
    on('btn-restart', () => setState(E.createSession(routine, state.day, Date.now())));
    on('btn-other-day', () => setState(null));
    on('btn-sound', () => Sound.test());
    on('btn-notif', askNotifications);
    const dlg = $('confirm-exit');
    $('dlg-stay').addEventListener('click', () => dlg.close());
    $('dlg-exit').addEventListener('click', () => { dlg.close(); setState(null); });

    // Desbloqueo del audio en cualquier toque (iOS/Android exigen un gesto del usuario)
    ['pointerup', 'touchend', 'click', 'keydown'].forEach(evt =>
      document.addEventListener(evt, () => Sound.unlock(), { capture: true, passive: true }));

    // Al volver a primer plano: recalcular con la hora real
    const onForeground = () => {
      if (document.visibilityState !== 'visible') return;
      if (Sound.ctx && Sound.ctx.state !== 'running') Sound.ctx.resume().catch(() => {});
      Sound.cancel(); // resincroniza el reloj de audio con el reloj real
      tick();
      syncEffects();
      if (!state || !state.alarm) closeNotifications();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', onForeground);
    window.addEventListener('focus', onForeground);

    setInterval(tick, 200);
  }

  async function loadRoutine() {
    const res = await fetch('routine.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`No se pudo leer routine.json (HTTP ${res.status})`);
    let raw;
    try { raw = await res.json(); } catch { throw new Error('routine.json tiene un error de formato (revisa comas y llaves)'); }
    return E.normalizeRoutine(raw);
  }

  async function boot() {
    bind();
    try {
      routine = await loadRoutine();
    } catch (err) {
      loadError = err && err.message ? err.message : 'No se pudo cargar routine.json';
    }
    if (routine) {
      const now = Date.now();
      let s = store.get(LS_SESSION);
      const lastActivity = s && Array.isArray(s.log) && s.log.length ? s.log[s.log.length - 1].at : s && s.startedAt;
      const fresh = s && (s.phase === 'done' ? now - s.finishedAt < DONE_KEEP_MS : now - lastActivity < SESSION_STALE_MS);
      if (fresh && E.isValidSession(s, routine)) {
        s = E.tick(s, now);
        if (s.alarm && now - s.alarmAt > ALARM_STALE_MS) s = E.stopAlarm(s);
        state = s;
        store.set(LS_SESSION, s);
      } else {
        store.del(LS_SESSION);
      }
    }
    syncEffects();
    render();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
}

if (typeof document !== 'undefined' && document.getElementById('app')) initApp();
if (typeof module !== 'undefined' && module.exports) module.exports = GymEngine;
