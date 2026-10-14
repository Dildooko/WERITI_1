/* WERITI — звуки и фоновая музыка.
   Всё синтезируется прямо в браузере (Web Audio API): внешних файлов и интернета не нужно.

   Sound.tap()      — мягкий «успешный» щелчок при нажатии на кнопку
   Sound.success()  — звонкий аккорд: регистрация или вход удались
   Sound.error()    — низкий звук: что-то не получилось
   Sound.music(on)  — фоновая музыка (играет, пока включён звук и пользователь вошёл)
   Sound.setEnabled(on) / Sound.enabled — общий выключатель звука */
const Sound = (() => {
  const SFX_VOL = 1.2;    // громкость звуков кнопок
  const MUSIC_VOL = 0.7;  // громкость фоновой музыки (чем меньше, тем тише)
  const CHORD_SEC = 8;    // сколько секунд звучит один аккорд

  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx, out, sfxBus, musicIn;
  let enabled = true, wantMusic = false;
  let bus = null, timer = 0, nextChord = 0, nextNote = 0, chordNo = 0, melPos = 3, lastErr = 0;

  const hz = m => 440 * Math.pow(2, (m - 69) / 12); // номер ноты MIDI → частота

  /* Cmaj7 → Am7 → Fmaj7 → G6: мягкая спокойная последовательность */
  const CHORDS = [[48, 55, 59, 64], [45, 55, 60, 64], [41, 57, 60, 64], [43, 59, 62, 64]];
  /* ноты мелодии — пентатоника до мажора, любая комбинация звучит мягко */
  const MELODY = [67, 69, 72, 74, 76, 79, 81, 84];

  function impulse(sec, decay) { // искусственное «эхо большого зала»
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }

  function init() {
    if (ctx || !AC) return ctx;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor(); // не даёт звукам сложиться в резкий пик
    out = ctx.createGain(); out.gain.value = 0.9;
    out.connect(comp); comp.connect(ctx.destination);

    sfxBus = ctx.createGain(); sfxBus.gain.value = SFX_VOL; sfxBus.connect(out);

    musicIn = ctx.createGain(); musicIn.gain.value = MUSIC_VOL;
    const dry = ctx.createGain(), wet = ctx.createGain(), rev = ctx.createConvolver();
    dry.gain.value = 0.7; wet.gain.value = 0.6; rev.buffer = impulse(3.4, 2.4);
    musicIn.connect(dry); dry.connect(out);
    musicIn.connect(rev); rev.connect(wet); wet.connect(out);
    return ctx;
  }

  /* Браузеры разрешают звук только после касания/клика — вызываем при первом же жесте. */
  function unlock() {
    if (!init() || ctx.state === 'running') return;
    const p = ctx.resume(); if (p && p.catch) p.catch(() => {});
  }

  function play(fn) {
    if (!enabled || !init()) return;
    if (ctx.state === 'running') return fn(ctx.currentTime + 0.01);
    const p = ctx.resume();
    if (p && p.then) p.then(() => { if (ctx.state === 'running') fn(ctx.currentTime + 0.01); }).catch(() => {});
  }

  function tone(freq, t, dur, o = {}) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.15, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (o.lp) { // срезаем резкие верха
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp;
      osc.connect(f); f.connect(g);
    } else osc.connect(g);
    g.connect(sfxBus);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  /* ---------- Звуки кнопок ---------- */
  const tap = () => play(t => {
    tone(880, t, 0.09, { type: 'triangle', vol: 0.1 });
    tone(1320, t + 0.02, 0.08, { vol: 0.04 });
  });

  const success = () => play(t =>
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.085, 0.42, { type: 'triangle', vol: 0.13 })));

  const error = () => {
    const now = Date.now(); if (now - lastErr < 300) return; lastErr = now; // не чаще раза в 0,3 с
    play(t => {
      tone(233, t, 0.16, { type: 'sawtooth', vol: 0.1, lp: 700 });
      tone(175, t + 0.17, 0.3, { type: 'sawtooth', vol: 0.1, lp: 600 });
    });
  };

  /* ---------- Фоновая музыка ---------- */
  function pad(notes, t, b) { // длинный мягкий аккорд
    notes.forEach((m, i) => [['sine', 0, 1], ['triangle', 7, 0.6]].forEach(([type, cents, k]) => {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      const v = (i === 0 ? 0.05 : 0.03) * k;
      o.type = type; o.frequency.value = hz(m); o.detune.value = cents + Math.random() * 4 - 2;
      f.type = 'lowpass'; f.frequency.value = 1100;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 2.5);
      g.gain.setValueAtTime(v, t + CHORD_SEC);
      g.gain.linearRampToValueAtTime(0, t + CHORD_SEC + 3.5);
      o.connect(f); f.connect(g); g.connect(b);
      o.start(t); o.stop(t + CHORD_SEC + 3.6);
    }));
  }

  function pluck(m, t, b) { // отдельная нежная нота, как у колокольчика
    [[1, 0.07], [2, 0.018]].forEach(([mul, vol]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = hz(m) * mul;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      o.connect(g); g.connect(b);
      o.start(t); o.stop(t + 3.3);
    });
  }

  function tick() { // заранее расставляем аккорды и ноты на несколько секунд вперёд
    if (!bus) return;
    const now = ctx.currentTime;
    while (nextChord < now + 6) { pad(CHORDS[chordNo++ % CHORDS.length], nextChord, bus); nextChord += CHORD_SEC; }
    while (nextNote < now + 4) {
      melPos = Math.max(0, Math.min(MELODY.length - 1, melPos + Math.floor(Math.random() * 5) - 2));
      pluck(MELODY[melPos], nextNote, bus);
      nextNote += 1.8 + Math.random() * 3;
    }
  }

  function startMusic() {
    if (bus || !init()) return;
    unlock();
    const t = ctx.currentTime;
    bus = ctx.createGain();
    bus.gain.setValueAtTime(0, t); bus.gain.linearRampToValueAtTime(1, t + 3); // плавное появление
    bus.connect(musicIn);
    nextChord = t + 0.1; nextNote = t + 3; chordNo = 0; melPos = 3;
    tick(); timer = setInterval(tick, 1000);
  }

  function stopMusic() {
    clearInterval(timer);
    if (!bus) return;
    const b = bus, t = ctx.currentTime; bus = null;
    b.gain.cancelScheduledValues(t); b.gain.setValueAtTime(b.gain.value, t);
    b.gain.linearRampToValueAtTime(0, t + 1); // плавное затухание
    setTimeout(() => { try { b.disconnect(); } catch (e) {} }, 1200);
  }

  const sync = () => (enabled && wantMusic ? startMusic() : stopMusic());

  /* Вкладка скрыта — ставим звук на паузу, вернулись — продолжаем. */
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) { const p = ctx.suspend(); if (p && p.catch) p.catch(() => {}); }
    else unlock();
  });

  return {
    unlock, tap, success, error,
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; sync(); },
    music(v) { wantMusic = !!v; sync(); },
  };
})();
