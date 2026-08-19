// 資料庫層：使用 libSQL（SQLite 的雲端相容版本）
// - 本機開發：沒有設定環境變數時，自動用本機檔案 data.db，跟以前一樣零設定可跑
// - 雲端／正式上線：設定 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 後，會改連到 Turso 雲端資料庫，
//   資料不會因為主機重啟/重新部署而消失
const { createClient } = require('@libsql/client');
const path = require('path');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'data.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function init() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT '其他',
      available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      table_no TEXT,
      pickup_name TEXT,
      pickup_phone TEXT,
      pickup_time TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      total INTEGER NOT NULL DEFAULT 0,
      paid INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER,
      product_name TEXT NOT NULL,
      price INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const { rows } = await client.execute('SELECT COUNT(*) AS c FROM products');
  if (Number(rows[0].c) === 0) {
    const seed = [
      ['乾拌麵', 60, '麵食', 1],
      ['陽春麵', 50, '麵食', 2],
      ['滷豆干（4片）', 39, '滷味', 1],
      ['滷豆干（5片）', 48, '滷味', 2],
      ['雞腳（7支）', 50, '滷味', 3],
      ['豬耳朵（整支）', 120, '滷味', 4],
    ];
    for (const args of seed) {
      await client.execute({ sql: 'INSERT INTO products (name, price, category, sort_order) VALUES (?, ?, ?, ?)', args });
    }
  }
}

async function getSetting(key) {
  const { rows } = await client.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await client.execute({
    sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    args: [key, value],
  });
}

module.exports = { client, init, getSetting, setSetting };
