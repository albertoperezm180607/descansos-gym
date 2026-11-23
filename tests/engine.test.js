/* Pruebas del motor (GymEngine). El tiempo se simula pasando `now` a mano:
   no hay setInterval de por medio, igual que en la app real. */
(async () => {
  const E = GymEngine;
  const results = [];
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  const eq = (got, want, msg = '') => {
    if (got !== want) throw new Error(`${msg} esperado ${JSON.stringify(want)}, obtenido ${JSON.stringify(got)}`);
  };
  const ok = (v, msg = 'esperado verdadero') => { if (!v) throw new Error(msg); };

  const S = 1000;
  const T0 = 1_700_000_000_000;
  const R = E.normalizeRoutine({
    dias: [
      {
        nombre: 'Prueba',
        ejercicios: [
          { nombre: 'A', series: 3, reps: '8', peso: '50 kg', descanso_serie: 90, descanso_tras_ejercicio: 120 },
          { nombre: 'B', series: 2, reps: '10', peso: '20 kg', descanso_serie: 60, descanso_tras_ejercicio: 150 },
        ],
      },
      { nombre: 'Vacío', ejercicios: [] },
    ],
  });
  const fresh = (now = T0) => E.createSession(R, 0, now);

  /* ---------- Rutina ---------- */
  test('normaliza la rutina: descarta días vacíos y rellena valores por defecto', () => {
    eq(R.dias.length, 1, 'días');
    const r = E.normalizeRoutine({ dias: [{ nombre: 'X', ejercicios: [{ nombre: 'Y', descanso_serie: '45', descanso_tras_ejercicio: -3 }] }] });
    const e = r.dias[0].ejercicios[0];
    eq(e.series, 1, 'series por defecto');
    eq(e.descanso_serie, 45, 'texto "45" → 45 s');
    eq(e.descanso_tras_ejercicio, 120, 'negativo → por defecto');
    eq(e.reps, '', 'reps vacías');
  });

  test('rechaza una rutina sin días', () => {
    let threw = false;
    try { E.normalizeRoutine({ dias: [] }); } catch { threw = true; }
    ok(threw, 'debería lanzar error');
  });

  /* ---------- Descansos ---------- */
  test('entre series usa descanso_serie (90 s) y apunta a la siguiente serie', () => {
    const s = E.completeSet(fresh(), R, T0);
    eq(s.phase, 'rest');
    eq(s.rest.end, T0 + 90 * S, 'hora de fin');
    eq(s.ex, 0); eq(s.set, 1);
    eq(E.remaining(s, T0 + 30 * S), 60 * S, 'quedan 60 s a los 30 s');
  });

  test('tras la última serie de un ejercicio usa descanso_tras_ejercicio (120 s) y pasa al siguiente ejercicio', () => {
    let s = fresh();
    s = E.skip(E.completeSet(s, R, T0));          // A1 → A2
    s = E.skip(E.completeSet(s, R, T0));          // A2 → A3
    s = E.completeSet(s, R, T0);                  // A3 hecha
    eq(s.rest.total, 120 * S, 'descanso tras ejercicio');
    eq(s.ex, 1, 'siguiente ejercicio'); eq(s.set, 0, 'primera serie');
  });

  test('tick antes de acabar no cambia nada (mismo objeto)', () => {
    const s = E.completeSet(fresh(), R, T0);
    ok(E.tick(s, T0 + 89_999) === s);
    eq(E.remaining(s, T0 + 89_999), 1, 'queda 1 ms');
  });

  test('al llegar a 0 suena la alarma y la siguiente serie queda lista', () => {
    const s = E.tick(E.completeSet(fresh(), R, T0), T0 + 90 * S);
    eq(s.phase, 'work'); eq(s.alarm, true);
    eq(s.alarmAt, T0 + 90 * S);
    eq(s.set, 1, 'serie 2');
    const stopped = E.stopAlarm(s);
    eq(stopped.alarm, false); eq(stopped.phase, 'work'); eq(stopped.set, 1);
  });

  test('pantalla bloqueada 10 min sin ningún tick: al volver se detecta y la alarma marca la hora real de fin', () => {
    const s = E.tick(E.completeSet(fresh(), R, T0), T0 + 10 * 60 * S);
    eq(s.alarm, true);
    eq(s.alarmAt, T0 + 90 * S, 'sin desfase');
  });

  test('sin desfase con ticks irregulares (simula timers ralentizados)', () => {
    let s = E.completeSet(fresh(), R, T0);
    let now = T0;
    for (const step of [200, 1700, 33, 15_000, 4_000, 999, 60_000]) { now += step; s = E.tick(s, now); }
    eq(s.phase, 'rest', 'aún descansando a los ' + (now - T0) + ' ms');
    eq(E.remaining(s, now), 90 * S - (now - T0));
    now = T0 + 90 * S;
    s = E.tick(s, now);
    eq(s.alarm, true, 'alarma exacta a los 90 s');
  });

  test('progreso del anillo: 0 → 0,5 → 1', () => {
    const s = E.completeSet(fresh(), R, T0);
    eq(E.progress(s, T0), 0);
    eq(E.progress(s, T0 + 45 * S), 0.5);
    eq(E.progress(s, T0 + 90 * S), 1);
  });

  /* ---------- Botones ---------- */
  test('+15 s y −15 s mueven la hora de fin y el total', () => {
    let s = E.completeSet(fresh(), R, T0);
    s = E.adjust(s, 15, T0 + 10 * S);
    eq(E.remaining(s, T0 + 10 * S), 95 * S, '+15');
    eq(s.rest.total, 105 * S, 'total +15');
    s = E.adjust(s, -15, T0 + 20 * S);
    eq(E.remaining(s, T0 + 20 * S), 70 * S, '−15');
    ok(Math.abs(E.progress(s, T0 + 20 * S) - 20 / 90) < 1e-9, 'progreso coherente (20 de 90 s)');
  });

  test('−15 s con menos de 15 s restantes dispara la alarma al momento', () => {
    let s = E.completeSet(fresh(), R, T0);
    s = E.adjust(s, -15, T0 + 80 * S);
    eq(s.alarm, true); eq(s.phase, 'work');
    eq(s.alarmAt, T0 + 80 * S);
  });

  test('pausar congela el tiempo; reanudar continúa donde estaba', () => {
    let s = E.completeSet(fresh(), R, T0);
    s = E.togglePause(s, T0 + 30 * S);
    eq(E.remaining(s, T0 + 5 * 60 * S), 60 * S, 'congelado 5 min después');
    ok(E.tick(s, T0 + 5 * 60 * S) === s, 'en pausa no salta la alarma');
    s = E.togglePause(s, T0 + 5 * 60 * S);
    eq(s.rest.end, T0 + 5 * 60 * S + 60 * S, 'nueva hora de fin');
    s = E.tick(s, T0 + 6 * 60 * S);
    eq(s.alarm, true);
  });

  test('±15 s también funciona en pausa', () => {
    let s = E.togglePause(E.completeSet(fresh(), R, T0), T0 + 30 * S);
    s = E.adjust(s, 15, T0 + 40 * S);
    eq(s.rest.paused, 75 * S, '+15 en pausa');
    s = E.adjust(s, -90, T0 + 50 * S);
    eq(s.alarm, true, 'a 0 en pausa → alarma');
  });

  test('saltar descanso: siguiente serie sin alarma', () => {
    const s = E.skip(E.completeSet(fresh(), R, T0));
    eq(s.phase, 'work'); eq(s.alarm, false); eq(s.set, 1); eq(s.rest, null);
  });

  test('"Serie hecha" se ignora durante el descanso', () => {
    const s = E.completeSet(fresh(), R, T0);
    ok(E.completeSet(s, R, T0 + S) === s);
  });

  test('descanso de 0 s: pasa directo a la siguiente serie', () => {
    const r0 = E.normalizeRoutine({ dias: [{ nombre: 'Z', ejercicios: [{ nombre: 'Q', series: 2, descanso_serie: 0 }] }] });
    const s = E.completeSet(E.createSession(r0, 0, T0), r0, T0);
    eq(s.phase, 'work'); eq(s.set, 1); eq(s.alarm, false);
  });

  /* ---------- Día completo ---------- */
  test('día completo: descansos 90-90-120-60 y fin sin descanso final', () => {
    let s = fresh();
    let now = T0;
    const rests = [];
    while (s.phase !== 'done') {
      now += 40 * S;                       // la serie dura 40 s
      s = E.completeSet(s, R, now);
      if (s.phase === 'rest') {
        rests.push(s.rest.total / S);
        now = s.rest.end;
        s = E.stopAlarm(E.tick(s, now));
      }
    }
    eq(rests.join('-'), '90-90-120-60');
    eq(s.log.length, 5, 'series hechas');
    eq(s.finishedAt, now);
    eq(s.rest, null);
    const sum = E.summary(s, R, now);
    eq(sum.setsDone, 5); eq(sum.setsTotal, 5);
    eq(sum.durationMs, 5 * 40 * S + 360 * S, 'duración = series + descansos');
    eq(sum.exercises.map(x => `${x.nombre}:${x.hechas}/${x.series}`).join(' '), 'A:3/3 B:2/2');
  });

  /* ---------- Volver atrás ---------- */
  test('atrás durante el descanso: vuelve a la serie recién marcada', () => {
    const s = E.undo(E.completeSet(fresh(), R, T0));
    eq(s.phase, 'work'); eq(s.ex, 0); eq(s.set, 0); eq(s.log.length, 0); eq(s.rest, null);
  });

  test('atrás al inicio no hace nada', () => {
    const s = fresh();
    ok(E.undo(s) === s);
  });

  test('atrás desde el resumen vuelve a la última serie', () => {
    let s = fresh();
    while (s.phase !== 'done') s = E.skip(E.completeSet(s, R, T0));
    s = E.undo(s);
    eq(s.phase, 'work'); eq(s.ex, 1); eq(s.set, 1); eq(s.finishedAt, null);
  });

  test('atrás con la alarma sonando la para', () => {
    let s = E.tick(E.completeSet(fresh(), R, T0), T0 + 90 * S);
    s = E.undo(s);
    eq(s.alarm, false); eq(s.set, 0);
  });

  /* ---------- Persistencia ---------- */
  test('la sesión sobrevive a guardar/cargar (localStorage) en mitad de un descanso', () => {
    let s = E.completeSet(fresh(), R, T0);
    s = JSON.parse(JSON.stringify(s));
    ok(E.isValidSession(s, R), 'válida tras JSON');
    eq(E.remaining(s, T0 + 50 * S), 40 * S);
    eq(E.tick(s, T0 + 90 * S).alarm, true);
  });

  test('una sesión guardada no vale si cambiaste la rutina', () => {
    let s = fresh();
    s = E.skip(E.completeSet(s, R, T0));
    s = E.skip(E.completeSet(s, R, T0)); // en A serie 3
    const menos = E.normalizeRoutine({ dias: [{ nombre: 'Prueba', ejercicios: [{ nombre: 'A', series: 2 }] }] });
    ok(!E.isValidSession(s, menos), 'series reducidas');
    const renombrado = E.normalizeRoutine({ dias: [{ nombre: 'Otro', ejercicios: R.dias[0].ejercicios }] });
    ok(!E.isValidSession(s, renombrado), 'día renombrado');
    ok(E.isValidSession(s, R), 'misma rutina → válida');
  });

  /* ---------- Circuitos ---------- */
  const RC = E.normalizeRoutine({
    dias: [{
      nombre: 'Con circuito',
      ejercicios: [
        { nombre: 'Sentadilla', series: 2, reps: '5', descanso_serie: 150, descanso_tras_ejercicio: 120 },
        {
          circuito: 'Final', vueltas: 3, descanso_entre_ejercicios: 30, descanso_entre_vueltas: 120, descanso_tras_circuito: 45,
          ejercicios: [{ nombre: 'G' }, { nombre: 'C' }, { nombre: 'J' }],
        },
        { nombre: 'Estiramientos', series: 1 },
      ],
    }],
  });

  test('un circuito se despliega por vueltas: G C J · G C J · G C J', () => {
    const list = RC.dias[0].ejercicios;
    eq(list.length, 1 + 9 + 1, 'pasos');
    eq(list.slice(1, 10).map(e => `${e.nombre}${e.vuelta}`).join(' '), 'G1 C1 J1 G2 C2 J2 G3 C3 J3');
    ok(list.slice(1, 10).every(e => e.series === 1 && e.vueltas === 3 && e.circuito === 'Final'), 'cada paso = 1 serie');
    eq(RC.dias[0].numEjercicios, 5, 'ejercicios distintos');
    eq(list.map(e => e.orden).join(','), '1,2,3,4,2,3,4,2,3,4,5', 'orden');
  });

  test('descansos del circuito: 30 entre ejercicios, 120 entre vueltas, 45 al acabar', () => {
    let s = E.createSession(RC, 0, T0);
    let now = T0;
    const rests = [];
    while (s.phase !== 'done') {
      now += 20 * S;
      s = E.completeSet(s, RC, now);
      if (s.phase === 'rest') { rests.push(s.rest.total / S); now = s.rest.end; s = E.stopAlarm(E.tick(s, now)); }
    }
    eq(rests.join('-'), '150-120-30-30-120-30-30-120-30-30-45');
    const sum = E.summary(s, RC, now);
    eq(sum.exercises.map(x => `${x.nombre}:${x.hechas}/${x.series}`).join(' '), 'Sentadilla:2/2 G:3/3 C:3/3 J:3/3 Estiramientos:1/1');
    eq(sum.setsDone, 12); eq(sum.setsTotal, 12);
  });

  test('atrás dentro de un circuito vuelve al paso anterior', () => {
    let s = E.createSession(RC, 0, T0);
    for (let i = 0; i < 4; i++) s = E.skip(E.completeSet(s, RC, T0)); // 2 sentadillas + G1 + C1
    eq(RC.dias[0].ejercicios[s.ex].nombre + RC.dias[0].ejercicios[s.ex].vuelta, 'J1');
    s = E.undo(s);
    eq(RC.dias[0].ejercicios[s.ex].nombre + RC.dias[0].ejercicios[s.ex].vuelta, 'C1');
  });

  /* ---------- routine.json real ---------- */
  test('routine.json se carga y es válido', async () => {
    const res = await fetch('../routine.json', { cache: 'no-store' });
    eq(res.ok, true, 'HTTP');
    const r = E.normalizeRoutine(await res.json());
    ok(r.dias.length > 0, 'hay días');
    r.dias.forEach(d => d.ejercicios.forEach(e => {
      ok(e.series >= 1 && e.descanso_serie >= 0 && e.descanso_tras_ejercicio >= 0, `${d.nombre} / ${e.nombre}`);
    }));
  });

  test('routine.json: Fuerza G2 de TrainingPeaks completo', async () => {
    const r = E.normalizeRoutine(await (await fetch('../routine.json', { cache: 'no-store' })).json());
    const g2 = r.dias.find(d => d.nombre === 'Fuerza G2');
    ok(g2, 'existe el día');
    eq(g2.numEjercicios, 7, 'calentamiento + 3 básicos + 3 del circuito');
    eq(E.totalSets(r, r.dias.indexOf(g2)), 1 + 9 + 9, 'series totales');
    const sq = g2.ejercicios.find(e => e.nombre === 'Sentadilla');
    eq(`${sq.series}x${sq.reps} ${sq.peso}`, '3x5 77,5 kg');
    eq(`${sq.descanso_serie}/${sq.descanso_tras_ejercicio}`, '150/240', 'entre series 2-3\' · entre bloques 3-5\'');
  });

  test('routine.json: días de la rotación actual (G, G2, espalda-hombro)', async () => {
    const r = E.normalizeRoutine(await (await fetch('../routine.json', { cache: 'no-store' })).json());
    eq(r.dias.map(d => d.nombre).join(' | '), 'Fuerza G | Fuerza G2 | Espalda-hombro');
    const g = r.dias[0];
    eq(g.ejercicios.filter(e => e.vueltas).map(e => e.nombre).slice(0, 3).join(', '), 'Gemelos, Flexiones / press banca, Remo horizontal');
    const eh = r.dias[2];
    eq(eh.numEjercicios, 4); eq(E.totalSets(r, 2), 12, '4 ejercicios × 3 vueltas');
    eq(eh.ejercicios.map(e => e.descanso_tras_ejercicio).join(','), '0,0,0,60,0,0,0,60,0,0,0,60', 'sin pausa entre ejercicios, 1\' entre vueltas');
  });

  /* ---------- Ejecutar ---------- */
  for (const t of tests) {
    try { await t.fn(); results.push({ name: t.name, ok: true }); }
    catch (err) { results.push({ name: t.name, ok: false, err: err.message }); }
  }
  const passed = results.filter(r => r.ok).length;
  const ul = document.getElementById('results');
  results.forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'}</span> `;
    li.append(r.name);
    if (!r.ok) { const sm = document.createElement('small'); sm.textContent = r.err; li.append(sm); }
    ul.append(li);
  });
  const sumEl = document.getElementById('summary');
  sumEl.textContent = `${passed}/${results.length} pruebas superadas`;
  sumEl.className = passed === results.length ? 'pass' : 'fail';
  document.title = passed === results.length ? 'OK · Pruebas' : 'FALLAN · Pruebas';
  window.__testResults = { passed, total: results.length, results };
})();
