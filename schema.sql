-- База данных WERITI (SQLite). Выполняется при каждом входе в аккаунт.
--
-- У каждого пользователя своя отдельная база. В браузере она хранится только
-- в зашифрованном виде (AES-256-GCM); ключ получается из пароля и нигде не сохраняется.
-- Поэтому пароль в базе не лежит: расшифровать базу может только верный пароль.

-- Пользователь (в его базе всегда одна строка).
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  avatar     TEXT,               -- фото профиля (JPEG в формате data URL)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Каталог. Меняйте названия, описания и цены здесь:
-- при следующем входе пользователей данные в их базах обновятся (INSERT OR REPLACE).
CREATE TABLE IF NOT EXISTS products (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  descr TEXT NOT NULL,
  price REAL NOT NULL            -- цена за 1 кг, в евро
);

-- Корзина пользователя.
CREATE TABLE IF NOT EXISTS cart (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (user_id, product_id)
);

-- Личные настройки (например, включён ли звук).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR REPLACE INTO products (id, name, descr, price) VALUES
  (1, 'Кишмиш зелёный',   'Без косточек, мягкая медовая сладость.', 6.90),
  (2, 'Тайфи',            'Хрустящая ягода с лёгкой кислинкой.',    7.50),
  (3, 'Аркадия',          'Крупные ягоды с мускатным ароматом.',    8.20),
  (4, 'Лора',             'Сочный виноград с нежным вкусом.',       7.90),
  (5, 'Дамские пальчики', 'Вытянутые ягоды с тонкой кожицей.',      9.40),
  (6, 'Мускат белый',     'Яркий цветочный аромат.',                8.80);
