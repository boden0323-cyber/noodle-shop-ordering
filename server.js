const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { client, init } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// 員工後台密碼：正式使用前務必修改（用環境變數 STAFF_PASSWORD 覆蓋），預設僅供本機測試
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'admin123';
const staffTokens = new Set(); // 簡易記憶體 session，重啟伺服器會全部登出

app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

function requireStaff(req, res, next) {
  const token = req.cookies.staff_token;
  if (token && staffTokens.has(token)) return next();
  return res.status(401).json({ error: '未登入' });
}

// 統一錯誤處理：讓每個 async route 不用自己包 try/catch
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: '伺服器錯誤' });
});

// ---------- 員工登入 ----------
app.post('/api/staff/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== STAFF_PASSWORD) {
    return res.status(401).json({ error: '密碼錯誤' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  staffTokens.add(token);
  res.cookie('staff_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

app.post('/api/staff/logout', (req, res) => {
  staffTokens.delete(req.cookies.staff_token);
  res.clearCookie('staff_token');
  res.json({ ok: true });
});

app.get('/api/staff/check', (req, res) => {
  const token = req.cookies.staff_token;
  res.json({ loggedIn: !!(token && staffTokens.has(token)) });
});

// ---------- 商品：客人可看「上架中」商品 ----------
app.get('/api/products', h(async (req, res) => {
  const { rows } = await client.execute(
    'SELECT id, name, price, category, sort_order FROM products WHERE available = 1 ORDER BY category, sort_order, id'
  );
  res.json(rows);
}));

// ---------- 商品管理（員工） ----------
app.get('/api/staff/products', requireStaff, h(async (req, res) => {
  const { rows } = await client.execute('SELECT * FROM products ORDER BY category, sort_order, id');
  res.json(rows);
}));

app.post('/api/staff/products', requireStaff, h(async (req, res) => {
  const { name, price, category, sort_order } = req.body || {};
  if (!name || !Number.isFinite(price)) {
    return res.status(400).json({ error: '品名或價格不正確' });
  }
  const info = await client.execute({
    sql: 'INSERT INTO products (name, price, category, sort_order) VALUES (?, ?, ?, ?)',
    args: [name, Math.round(price), category || '其他', sort_order || 0],
  });
  res.json({ id: Number(info.lastInsertRowid) });
}));

app.put('/api/staff/products/:id', requireStaff, h(async (req, res) => {
  const { name, price, category, available, sort_order } = req.body || {};
  await client.execute({
    sql: 'UPDATE products SET name=?, price=?, category=?, available=?, sort_order=? WHERE id=?',
    args: [name, Math.round(price), category || '其他', available ? 1 : 0, sort_order || 0, req.params.id],
  });
  res.json({ ok: true });
}));

app.delete('/api/staff/products/:id', requireStaff, h(async (req, res) => {
  await client.execute({ sql: 'UPDATE products SET available = 0 WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
}));

// ---------- 訂單：客人送出訂單 ----------
app.post('/api/orders', h(async (req, res) => {
  const { type, table_no, pickup_name, pickup_phone, pickup_time, note, items } = req.body || {};

  if (!['dine_in', 'pickup'].includes(type)) {
    return res.status(400).json({ error: '訂單類型不正確' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '購物車是空的' });
  }
  if (type === 'dine_in' && !table_no) {
    return res.status(400).json({ error: '內用請提供桌號' });
  }
  if (type === 'pickup' && !pickup_name) {
    return res.status(400).json({ error: '預購請留姓名' });
  }

  const productIds = items.map((i) => i.product_id);
  const placeholders = productIds.map(() => '?').join(',');
  const { rows: products } = await client.execute({
    sql: `SELECT * FROM products WHERE id IN (${placeholders}) AND available = 1`,
    args: productIds,
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  let total = 0;
  const resolvedItems = [];
  for (const item of items) {
    const p = productMap.get(item.product_id);
    const qty = Math.max(1, parseInt(item.qty, 10) || 1);
    if (!p) return res.status(400).json({ error: `品項不存在或已下架（id ${item.product_id}）` });
    total += p.price * qty;
    resolvedItems.push({ product_id: p.id, product_name: p.name, price: p.price, qty, note: item.note || null });
  }

  const tx = await client.transaction('write');
  let orderId;
  try {
    const info = await tx.execute({
      sql: `INSERT INTO orders (type, table_no, pickup_name, pickup_phone, pickup_time, note, total)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [type, table_no || null, pickup_name || null, pickup_phone || null, pickup_time || null, note || null, total],
    });
    orderId = Number(info.lastInsertRowid);
    for (const it of resolvedItems) {
      await tx.execute({
        sql: `INSERT INTO order_items (order_id, product_id, product_name, price, qty, note)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [orderId, it.product_id, it.product_name, it.price, it.qty, it.note],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  res.json({ ok: true, order_id: orderId, order_no: '#' + String(orderId).padStart(4, '0'), total });
}));

// ---------- 訂單：員工查看／管理 ----------
async function attachItems(order) {
  const { rows } = await client.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [order.id] });
  order.items = rows;
  order.order_no = '#' + String(order.id).padStart(4, '0');
  return order;
}

app.get('/api/staff/orders', requireStaff, h(async (req, res) => {
  const { status } = req.query;
  let rows;
  if (status) {
    ({ rows } = await client.execute({ sql: 'SELECT * FROM orders WHERE status = ? ORDER BY id DESC', args: [status] }));
  } else {
    ({ rows } = await client.execute("SELECT * FROM orders WHERE status != 'cancelled' ORDER BY id DESC LIMIT 200"));
  }
  const orders = await Promise.all(rows.map(attachItems));
  res.json(orders);
}));

app.get('/api/staff/orders/:id', requireStaff, h(async (req, res) => {
  const { rows } = await client.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [req.params.id] });
  if (!rows[0]) return res.status(404).json({ error: '找不到訂單' });
  res.json(await attachItems(rows[0]));
}));

app.patch('/api/staff/orders/:id/status', requireStaff, h(async (req, res) => {
  const { status } = req.body || {};
  if (!['received', 'preparing', 'done', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: '狀態不正確' });
  }
  await client.execute({ sql: 'UPDATE orders SET status = ? WHERE id = ?', args: [status, req.params.id] });
  res.json({ ok: true });
}));

app.post('/api/staff/orders/:id/checkout', requireStaff, h(async (req, res) => {
  const { payment_method } = req.body || {};
  if (!['cash', 'card'].includes(payment_method)) {
    return res.status(400).json({ error: '請選擇收款方式' });
  }
  await client.execute({
    sql: "UPDATE orders SET paid = 1, payment_method = ?, paid_at = datetime('now','localtime') WHERE id = ?",
    args: [payment_method, req.params.id],
  });
  res.json({ ok: true });
}));

// ---------- 今日營業額簡易統計 ----------
app.get('/api/staff/summary/today', requireStaff, h(async (req, res) => {
  const { rows } = await client.execute(`
    SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(CASE WHEN paid = 1 THEN total ELSE 0 END), 0) AS paid_total,
      COALESCE(SUM(CASE WHEN paid = 0 THEN total ELSE 0 END), 0) AS unpaid_total
    FROM orders
    WHERE date(created_at) = date('now','localtime') AND status != 'cancelled'
  `);
  res.json(rows[0]);
}));

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`麵店點餐系統啟動：http://localhost:${PORT}`);
      console.log(`客人點餐頁：http://localhost:${PORT}/order.html`);
      console.log(`員工後台：  http://localhost:${PORT}/staff.html （預設密碼：${STAFF_PASSWORD}）`);
    });
  })
  .catch((err) => {
    console.error('資料庫初始化失敗：', err);
    process.exit(1);
  });
