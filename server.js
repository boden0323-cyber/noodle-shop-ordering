const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { client, init, getSetting, setSetting } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Instagram 長效期權杖：一次授權，之後自動續期 ----------
const IG_APP_ID = process.env.IG_APP_ID;
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const IG_REDIRECT_URI = process.env.IG_REDIRECT_URI || 'https://noodle-shop-ordering.onrender.com/ig-callback';

async function refreshIgTokenIfNeeded() {
  if (!IG_APP_SECRET) return;
  const token = await getSetting('ig_access_token');
  const expiresAt = await getSetting('ig_token_expires_at');
  if (!token) return;

  const daysLeft = expiresAt ? (Number(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24) : -1;
  if (daysLeft > 10) return; // 還很久才過期，不用急著換

  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`
    );
    const data = await res.json();
    if (data.access_token) {
      const newExpiresAt = Date.now() + data.expires_in * 1000;
      await setSetting('ig_access_token', data.access_token);
      await setSetting('ig_token_expires_at', String(newExpiresAt));
      console.log('Instagram權杖已自動續期，新到期時間：', new Date(newExpiresAt).toLocaleString());
    } else {
      console.error('Instagram權杖續期失敗：', data);
    }
  } catch (err) {
    console.error('Instagram權杖續期發生錯誤：', err);
  }
}

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

// ---------- Instagram OAuth 授權回呼：訪問一次授權連結後，這裡自動完成長效期權杖交換 ----------
app.get('/ig-callback', h(async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.status(400).send(`授權失敗：${error_description || error}`);
  }
  if (!code) {
    return res.status(400).send('缺少授權碼');
  }
  if (!IG_APP_ID || !IG_APP_SECRET) {
    return res.status(500).send('伺服器尚未設定 IG_APP_ID / IG_APP_SECRET 環境變數');
  }

  // 1. 用授權碼換短效期權杖
  const form = new URLSearchParams({
    client_id: IG_APP_ID,
    client_secret: IG_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: IG_REDIRECT_URI,
    code: String(code).replace(/#_$/, ''), // Instagram有時會在code結尾多加 #_
  });
  const shortRes = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
  const shortData = await shortRes.json();
  if (!shortData.access_token) {
    return res.status(400).send('<pre>短效期權杖交換失敗：\n' + JSON.stringify(shortData, null, 2) + '</pre>');
  }

  // 2. 換成長效期權杖（60天，之後可用 refresh 續期，不需要再重新授權）
  const longRes = await fetch(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${IG_APP_SECRET}&access_token=${shortData.access_token}`
  );
  const longData = await longRes.json();
  if (!longData.access_token) {
    return res.status(400).send('<pre>長效期權杖交換失敗：\n' + JSON.stringify(longData, null, 2) + '</pre>');
  }

  const expiresAt = Date.now() + longData.expires_in * 1000;
  await setSetting('ig_access_token', longData.access_token);
  await setSetting('ig_token_expires_at', String(expiresAt));
  await setSetting('ig_user_id', String(shortData.user_id));

  res.send(`
    <h2>Instagram 授權成功 ✅</h2>
    <p>長效期權杖已存好，到期時間：${new Date(expiresAt).toLocaleString('zh-TW')}</p>
    <p>之後系統會在到期前自動續期，不用再重新走這個流程，這頁可以關掉了。</p>
  `);
}));

// ---------- 排程發文：定期檢查到期的貼文並自動發布到Instagram ----------
async function publishToInstagram(post) {
  const token = await getSetting('ig_access_token');
  const igUserId = await getSetting('ig_user_id');
  if (!token || !igUserId) throw new Error('Instagram尚未授權，找不到權杖');

  const videoUrl = `https://noodle-shop-ordering.onrender.com/ig-videos/${post.video_path}`;

  const createRes = await fetch(`https://graph.instagram.com/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify({
      video_url: videoUrl,
      media_type: 'REELS',
      caption: post.caption,
      access_token: token,
    }), 'utf8'),
  });
  const createData = await createRes.json();
  if (!createData.id) throw new Error('建立容器失敗：' + JSON.stringify(createData));

  // 輪詢處理狀態，最多等5分鐘
  let statusCode = 'IN_PROGRESS';
  for (let i = 0; i < 30 && statusCode === 'IN_PROGRESS'; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const statusRes = await fetch(`https://graph.instagram.com/${createData.id}?fields=status_code&access_token=${token}`);
    const statusData = await statusRes.json();
    statusCode = statusData.status_code;
  }
  if (statusCode !== 'FINISHED') throw new Error('影片處理未完成，狀態：' + statusCode);

  const publishRes = await fetch(`https://graph.instagram.com/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify({ creation_id: createData.id, access_token: token }), 'utf8'),
  });
  const publishData = await publishRes.json();
  if (!publishData.id) throw new Error('發布失敗：' + JSON.stringify(publishData));

  const detailRes = await fetch(`https://graph.instagram.com/${publishData.id}?fields=permalink&access_token=${token}`);
  const detailData = await detailRes.json();

  return { mediaId: publishData.id, permalink: detailData.permalink };
}

async function publishDuePosts() {
  const { rows } = await client.execute(
    "SELECT * FROM scheduled_posts WHERE status = 'pending' AND scheduled_at <= datetime('now','localtime')"
  );
  for (const post of rows) {
    try {
      const result = await publishToInstagram(post);
      await client.execute({
        sql: "UPDATE scheduled_posts SET status = 'posted', posted_media_id = ?, posted_permalink = ? WHERE id = ?",
        args: [result.mediaId, result.permalink, post.id],
      });
      console.log(`排程貼文 #${post.id} 發布成功：${result.permalink}`);
    } catch (err) {
      await client.execute({
        sql: "UPDATE scheduled_posts SET status = 'failed', error = ? WHERE id = ?",
        args: [String(err.message || err), post.id],
      });
      console.error(`排程貼文 #${post.id} 發布失敗：`, err);
    }
  }
}

app.get('/api/staff/scheduled-posts', requireStaff, h(async (req, res) => {
  const { rows } = await client.execute('SELECT * FROM scheduled_posts ORDER BY scheduled_at');
  res.json(rows);
}));

app.get('/api/staff/ig-status', requireStaff, h(async (req, res) => {
  const token = await getSetting('ig_access_token');
  const expiresAt = await getSetting('ig_token_expires_at');
  const userId = await getSetting('ig_user_id');
  res.json({
    connected: !!token,
    user_id: userId,
    expires_at: expiresAt ? new Date(Number(expiresAt)).toISOString() : null,
    days_left: expiresAt ? Math.floor((Number(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24)) : null,
  });
}));

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
  .then(async () => {
    await refreshIgTokenIfNeeded(); // 啟動時先檢查一次，快到期就順便換新
    setInterval(refreshIgTokenIfNeeded, 12 * 60 * 60 * 1000); // 之後每12小時檢查一次

    await publishDuePosts(); // 啟動時先檢查一次有沒有該發的排程貼文
    setInterval(publishDuePosts, 60 * 60 * 1000); // 之後每小時檢查一次

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
