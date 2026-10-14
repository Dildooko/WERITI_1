const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/';
const VAULT = 'weriti-vault:';  // зашифрованные базы пользователей (по одной на аккаунт)
const LEGACY = 'weriti-sqlite'; // старая незашифрованная база: нужна только чтобы перенести из неё аккаунты
const ITER = 600000;            // раундов PBKDF2: чем больше, тем сложнее подобрать пароль
const $ = id => document.getElementById(id);
const enc = new TextEncoder();
let SQL, schema, db = null, vault = null, user = null, mode = 'login', products = [], cart = new Map();

const toB64 = b => { let s = ''; new Uint8Array(b).forEach(x => s += String.fromCharCode(x)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const fmt = n => n.toFixed(2).replace('.', ',') + ' €';
const friendly = e => e && e.name === 'QuotaExceededError' ? 'В браузере не хватает места для данных.' : (e && e.message) || 'Что-то пошло не так.';

/* ---------- SQLite (sql.js): база живёт в памяти, на диск попадает только зашифрованной ---------- */
async function initEngine() {
  [SQL, schema] = await Promise.all([
    initSqlJs({ locateFile: f => CDN + f }),
    fetch('schema.sql').then(r => { if (!r.ok) throw new Error('schema.sql'); return r.text(); }),
  ]);
}
const newDB = bytes => { const d = new SQL.Database(bytes); d.run(schema); return d; };
function all(sql, p = [], d = db) {
  const st = d.prepare(sql); st.bind(p);
  const rows = []; while (st.step()) rows.push(st.getAsObject());
  st.free(); return rows;
}
function run(sql, p = []) { db.run(sql, p); save(); }
const getSetting = k => (all('SELECT value FROM settings WHERE key = ?', [k])[0] || {}).value;
const setSetting = (k, v) => run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, v]);

/* ---------- Шифрование: пароль → ключ AES-256-GCM ----------
   Ключ получается из пароля (PBKDF2) и хранится только в памяти страницы.
   Верный пароль проверяется самим шифром: с неверным паролем база просто не расшифруется. */
const norm = s => s.normalize('NFKC'); // одинаковые символы с разных клавиатур → один и тот же ключ
async function vaultId(name) { // имя ячейки в localStorage: по ней логин не прочитать
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('weriti:' + norm(name))));
  return [...h.slice(0, 16)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(norm(pass)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(v, bytes) { // каждый раз новый случайный iv
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, v.key, bytes);
  return JSON.stringify({ v: 2, it: v.iter, s: toB64(v.salt), iv: toB64(iv), d: toB64(ct) });
}
async function unseal(raw, pass) {
  let o, salt, iv, data;
  try { o = JSON.parse(raw); salt = fromB64(o.s); iv = fromB64(o.iv); data = fromB64(o.d); }
  catch (e) { throw new Error('Данные аккаунта повреждены.'); }
  const key = await deriveKey(pass, salt, o.it);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return { key, salt, iter: o.it, plain: new Uint8Array(plain) };
  } catch (e) { throw new Error('Неверный логин или пароль.'); }
}
async function createVault(name, pass, d) { // новое хранилище с базой d
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const v = { id: await vaultId(name), salt, iter: ITER };
  v.key = await deriveKey(pass, salt, ITER);
  localStorage.setItem(VAULT + v.id, await seal(v, d.export()));
  return v;
}

/* Сохранение: после каждого изменения база шифруется и записывается в localStorage. */
let busy = null, dirty = false;
async function writeVault() {
  if (db && vault) localStorage.setItem(VAULT + vault.id, await seal(vault, db.export()));
}
function save() {
  dirty = true;
  if (!busy) busy = (async () => {
    try { while (dirty) { dirty = false; await writeVault(); } }
    catch (e) { console.error(e); Sound.error(); toast(e && e.name === 'QuotaExceededError' ? 'Не удалось сохранить: в браузере не хватает места' : 'Не удалось сохранить данные'); }
    finally { busy = null; }
  })();
  return busy;
}

/* ---------- Аккаунты ---------- */
async function register(name, pass) {
  if (localStorage.getItem(VAULT + await vaultId(name)) || legacyUser(name)) throw new Error('Такой логин уже занят.');
  const d = newDB(); d.run('INSERT INTO users (username) VALUES (?)', [name]);
  try { await createVault(name, pass, d); } finally { d.close(); }
}
async function login(name, pass) {
  const id = await vaultId(name);
  let raw = localStorage.getItem(VAULT + id);
  if (!raw && await migrateLegacy(name, pass)) raw = localStorage.getItem(VAULT + id);
  if (!raw) throw new Error('Неверный логин или пароль.');
  const o = await unseal(raw, pass);
  db = newDB(o.plain);
  vault = { id, key: o.key, salt: o.salt, iter: o.iter };
}
function lock() { // забываем ключ и базу: без пароля данные снова недоступны
  if (db) db.close();
  db = vault = user = null; cart = new Map(); products = [];
}

/* ---------- Перенос аккаунтов из старой версии (там база лежала открытой) ---------- */
function legacyDB() {
  const s = localStorage.getItem(LEGACY); if (!s) return null;
  try { return new SQL.Database(fromB64(s)); } catch (e) { return null; }
}
function legacyUser(name) {
  const d = legacyDB(); if (!d) return null;
  try { return all('SELECT * FROM users WHERE username = ?', [name], d)[0] || null; }
  catch (e) { return null; } finally { d.close(); }
}
async function legacyHash(pass, salt) { // так пароль хешировался раньше
  const k = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return toB64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, k, 256));
}
async function migrateLegacy(name, pass) {
  const old = legacyDB(); if (!old) return false;
  try {
    const u = all('SELECT * FROM users WHERE username = ?', [name], old)[0];
    if (!u || await legacyHash(pass, fromB64(u.salt)) !== u.pass_hash) return false;
    const d = newDB();
    try {
      d.run('INSERT INTO users (username, avatar, created_at) VALUES (?, ?, ?)', [u.username, u.avatar, u.created_at]);
      const nid = all('SELECT id FROM users', [], d)[0].id;
      all('SELECT product_id, qty FROM cart WHERE user_id = ?', [u.id], old)
        .forEach(r => d.run('INSERT OR IGNORE INTO cart (user_id, product_id, qty) VALUES (?, ?, ?)', [nid, r.product_id, r.qty]));
      await createVault(name, pass, d);
    } finally { d.close(); }
    // перенесённого пользователя убираем из старой открытой базы; когда она опустеет — удаляем совсем
    old.run('DELETE FROM cart WHERE user_id = ?', [u.id]); old.run('DELETE FROM users WHERE id = ?', [u.id]);
    if (all('SELECT COUNT(*) AS n FROM users', [], old)[0].n) localStorage.setItem(LEGACY, toB64(old.export()));
    else localStorage.removeItem(LEGACY);
    return true;
  } finally { old.close(); }
}

/* ---------- Экраны ---------- */
function showApp() {
  user = db ? all('SELECT id, username, avatar FROM users LIMIT 1')[0] || null : null;
  $('auth').hidden = !!user; $('shop').hidden = !user;
  if (!user) { Sound.music(false); return; }
  products = all('SELECT * FROM products ORDER BY id');
  cart = new Map(all('SELECT product_id, qty FROM cart WHERE user_id = ?', [user.id]).map(r => [r.product_id, r.qty]));
  Sound.setEnabled(Sound.enabled && getSetting('sound') !== '0'); paintSound(); // личная настройка звука
  Sound.music(true); // после входа — спокойная музыка на фоне
  $('hello').textContent = 'Здравствуйте, ' + user.username;
  setAvatar(); renderGrid(); renderCart();
}
const msg = (t, cls = '') => { $('authMsg').textContent = t; $('authMsg').className = 'msg ' + cls; };
const authLabel = () => mode === 'register' ? 'Создать аккаунт' : 'Войти';
function setMode(m) {
  mode = m; const reg = m === 'register';
  $('authTitle').textContent = reg ? 'Регистрация' : 'Вход';
  $('authSub').textContent = reg ? 'Придумайте логин и пароль (от 6 символов). Пароль шифрует ваши данные, восстановить его нельзя.' : 'Введите логин и пароль.';
  $('authBtn').textContent = authLabel();
  $('switchText').textContent = reg ? 'Уже есть аккаунт?' : 'Нет аккаунта?';
  $('switchBtn').textContent = reg ? 'Войти' : 'Зарегистрироваться';
  $('pass').autocomplete = reg ? 'new-password' : 'current-password';
  msg('');
}
$('switchBtn').onclick = () => setMode(mode === 'login' ? 'register' : 'login');
$('authForm').addEventListener('invalid', () => Sound.error(), true); // подсказка браузера «слишком короткий пароль» тоже со звуком
$('authForm').onsubmit = async e => {
  e.preventDefault(); Sound.unlock(); // разрешаем звук, пока есть касание пользователя
  const name = $('login').value.trim().toLowerCase(), pass = $('pass').value, reg = mode === 'register';
  $('authBtn').disabled = true; $('authBtn').textContent = reg ? 'Шифруем…' : 'Расшифровываем…';
  try {
    if (reg) { await register(name, pass); setMode('login'); msg('Аккаунт создан. Теперь войдите.', 'ok'); $('pass').value = ''; }
    else { await login(name, pass); $('authForm').reset(); showApp(); }
    Sound.success();
  } catch (err) { msg(friendly(err), 'err'); Sound.error(); }
  $('authBtn').disabled = false; $('authBtn').textContent = authLabel();
};
$('logout').onclick = async () => { toggleCart(false); await save(); lock(); showApp(); };

/* ---------- Звук: выключатель ---------- */
function paintSound() {
  document.querySelectorAll('.soundtoggle').forEach(b => {
    b.classList.toggle('off', !Sound.enabled);
    b.setAttribute('aria-pressed', Sound.enabled);
    b.title = Sound.enabled ? 'Звук включён' : 'Звук выключен';
  });
}
document.querySelectorAll('.soundtoggle').forEach(b => b.onclick = () => {
  Sound.setEnabled(!Sound.enabled); paintSound();
  if (user) setSetting('sound', Sound.enabled ? '1' : '0');
});

/* ---------- Реакция кнопок: звук нажатия и волна от места касания ---------- */
addEventListener('pointerdown', Sound.unlock, { passive: true });
addEventListener('keydown', Sound.unlock);
document.addEventListener('touchstart', () => {}, { passive: true }); // без этого :active не работает в Safari на iPhone
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && !b.disabled && !b.hasAttribute('data-nosound')) Sound.tap();
});
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('.btn, .iconbtn, .step button, .ava');
  if (!b || b.disabled || e.button || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2, s = document.createElement('span');
  s.className = 'ripple';
  s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
  b.append(s); setTimeout(() => s.remove(), 700);
});

/* ---------- Аватар ---------- */
function setAvatar() {
  document.querySelectorAll('.ava').forEach(b => {
    if (user.avatar) { b.innerHTML = ''; const i = new Image(); i.src = user.avatar; i.alt = ''; b.append(i); }
    else b.textContent = user.username[0].toUpperCase();
  });
}
const pick = () => $('file').click();
document.querySelectorAll('.ava').forEach(b => b.onclick = pick);
$('photoBtn').onclick = pick;
$('file').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = c.height = 160; // сжимаем до 160×160, чтобы база оставалась лёгкой
    const s = Math.min(img.width, img.height);
    c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 160, 160);
    user.avatar = c.toDataURL('image/jpeg', .85);
    run('UPDATE users SET avatar = ? WHERE id = ?', [user.avatar, user.id]);
    setAvatar(); toast('Фото обновлено'); Sound.success(); URL.revokeObjectURL(img.src);
  };
  img.onerror = () => { toast('Не удалось открыть это изображение'); Sound.error(); };
  img.src = URL.createObjectURL(f); e.target.value = '';
};

/* ---------- Каталог и корзина ---------- */
function renderGrid() {
  $('grid').innerHTML = products.map(p => `
    <article class="prod"><div class="pic"><svg aria-hidden="true"><use href="#grapes"/></svg></div>
      <div class="pbody"><h2>${p.name}</h2><p>${p.descr}</p>
        <div class="row"><span class="price">${fmt(p.price)} / кг</span>
          <span data-p="${p.id}"><button class="btn add" data-act="add" data-id="${p.id}">В корзину</button>
            <span class="step" hidden><button data-act="dec" data-id="${p.id}" aria-label="Меньше">−</button><b></b><button data-act="inc" data-id="${p.id}" aria-label="Больше">+</button></span></span>
        </div></div></article>`).join('');
}
function setQty(id, q) {
  q = Math.min(q, 99);
  if (q <= 0) { cart.delete(id); run('DELETE FROM cart WHERE user_id = ? AND product_id = ?', [user.id, id]); }
  else { cart.set(id, q); run('INSERT OR REPLACE INTO cart (user_id, product_id, qty) VALUES (?, ?, ?)', [user.id, id, q]); }
  renderCart();
}
function renderCart() {
  const f = document.activeElement, area = f && f.closest('#items') ? '#items' : '#grid';
  let total = 0, n = 0;
  $('items').innerHTML = [...cart].map(([id, q]) => {
    const p = products.find(x => x.id === id); total += p.price * q; n += q;
    return `<li><div><b>${p.name}</b><br><small>${fmt(p.price)} / кг</small></div>
      <div class="step"><button data-act="dec" data-id="${id}" aria-label="Меньше">−</button><b>${q} кг</b><button data-act="inc" data-id="${id}" aria-label="Больше">+</button></div></li>`;
  }).join('');
  $('empty').hidden = cart.size > 0; $('total').textContent = fmt(total);
  $('count').textContent = n; $('checkout').disabled = !cart.size;
  document.querySelectorAll('[data-p]').forEach(w => {
    const q = cart.get(+w.dataset.p) || 0, s = w.querySelector('.step');
    w.querySelector('.add').hidden = q > 0; s.hidden = !q; s.querySelector('b').textContent = q + ' кг';
  });
  if (f && f.dataset && f.dataset.id) // возвращаем фокус на кнопку после обновления
    for (const a of [f.dataset.act, 'inc', 'add']) {
      const el = document.querySelector(`${area} [data-act="${a}"][data-id="${f.dataset.id}"]`);
      if (el && el.offsetParent) { el.focus(); break; }
    }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = +b.dataset.id, q = cart.get(id) || 0;
  setQty(id, b.dataset.act === 'dec' ? q - 1 : q + 1);
});
function toggleCart(open) {
  $('cart').classList.toggle('open', open); $('scrim').classList.toggle('open', open);
  if (open) $('closeCart').focus(); else if (!$('shop').hidden) $('cartBtn').focus();
}
$('cartBtn').onclick = () => toggleCart(true);
$('closeCart').onclick = $('scrim').onclick = () => toggleCart(false);
addEventListener('keydown', e => { if (e.key === 'Escape') toggleCart(false); });
$('checkout').onclick = () => {
  run('DELETE FROM cart WHERE user_id = ?', [user.id]); cart.clear(); renderCart();
  toggleCart(false); toast('Заказ принят. Спасибо!'); Sound.success();
};
let tt;
function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => e.classList.remove('show'), 2500); }

/* ---------- Запуск ---------- */
sessionStorage.removeItem('uid'); // остаток от старой версии: теперь вход живёт только в памяти страницы
$('auth').hidden = false;
if (!(window.crypto && crypto.subtle)) {
  msg('Для шифрования нужен защищённый адрес: откройте сайт по https:// или через localhost.', 'err');
} else {
  initEngine().then(() => { setMode('login'); $('authBtn').disabled = false; })
    .catch(() => msg('Не удалось загрузить базу. Проверьте интернет и откройте сайт через GitHub Pages или локальный сервер.', 'err'));
}
