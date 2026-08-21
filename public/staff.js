const STATUS_LABEL = { received: '待處理', preparing: '製作中', done: '已完成', cancelled: '已取消' };
let pollTimer = null;

// LINE內建瀏覽器常有相容性問題，偵測到就提示改用手機預設瀏覽器開啟
if (/\bLine\//i.test(navigator.userAgent)) {
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#fff3cd;color:#7a5b00;padding:10px 14px;font-size:13px;text-align:center;line-height:1.5;';
  banner.innerHTML = `
    為了畫面能正常顯示，建議點右上角「⋯」選單，選「在瀏覽器中開啟」
    <button id="copyLinkBtn" style="margin-left:6px;padding:3px 10px;border:none;border-radius:6px;background:#7a2e1d;color:#fff;font-size:12px;">複製連結</button>
  `;
  document.body.prepend(banner);
  document.getElementById('copyLinkBtn').onclick = () => {
    navigator.clipboard?.writeText(location.href).then(() => alert('連結已複製，貼到瀏覽器網址列開啟即可'));
  };
}

async function checkLogin() {
  const res = await fetch('/api/staff/check');
  const { loggedIn } = await res.json();
  if (loggedIn) enterStaffArea();
}

document.getElementById('loginBtn').onclick = doLogin;
document.getElementById('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const password = document.getElementById('pwInput').value;
  const res = await fetch('/api/staff/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    enterStaffArea();
  } else {
    document.getElementById('loginErr').textContent = '密碼錯誤';
  }
}

document.getElementById('logoutBtn').onclick = async () => {
  await fetch('/api/staff/logout', { method: 'POST' });
  location.reload();
};

function enterStaffArea() {
  document.getElementById('loginArea').style.display = 'none';
  document.getElementById('staffArea').style.display = 'block';
  document.getElementById('logoutBtn').style.display = 'inline-block';
  loadOrders();
  loadSummary();
  pollTimer = setInterval(() => { loadOrders(); loadSummary(); }, 4000);
}

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('ordersTab').style.display = tab === 'orders' ? 'block' : 'none';
    document.getElementById('productsTab').style.display = tab === 'products' ? 'block' : 'none';
    if (tab === 'products') loadProducts();
  };
});

async function loadSummary() {
  const res = await fetch('/api/staff/summary/today');
  const s = await res.json();
  document.getElementById('sumCount').textContent = s.order_count;
  document.getElementById('sumPaid').textContent = s.paid_total;
  document.getElementById('sumUnpaid').textContent = s.unpaid_total;
}

async function loadOrders() {
  const res = await fetch('/api/staff/orders');
  const orders = await res.json();
  const el = document.getElementById('ordersTab');
  el.innerHTML = orders.map(renderOrderCard).join('') || '<p>目前沒有訂單</p>';
  // 重新綁定事件（因為 innerHTML 重繪會清掉舊的監聽器）
  orders.forEach((o) => {
    const card = document.getElementById(`order-${o.id}`);
    if (!card) return;
    card.querySelectorAll('[data-status]').forEach((btn) => {
      btn.onclick = () => updateStatus(o.id, btn.dataset.status);
    });
    const printBtn = card.querySelector('[data-print]');
    if (printBtn) printBtn.onclick = () => window.open(`/print.html?order=${o.id}`, '_blank');
    const checkoutBtn = card.querySelector('[data-checkout]');
    if (checkoutBtn) checkoutBtn.onclick = () => checkout(o.id);
  });
}

function renderOrderCard(o) {
  const typeLabel = { dine_in: `內用 ${o.table_no}桌`, takeout: `外帶・${o.pickup_name}`, pickup: `預購取貨・${o.pickup_name}` };
  const src = typeLabel[o.type] || o.type;
  const itemsHtml = o.items.map((it) => `${it.product_name} x${it.qty}${it.note ? `（${it.note}）` : ''}`).join('、');
  const payTag = o.paid ? `<span class="paid-tag">已收款(${o.payment_method === 'cash' ? '現金' : '刷卡'})</span>` : `<span class="unpaid-tag">未收款</span>`;
  return `
    <div class="order-card status-${o.status}" id="order-${o.id}">
      <div class="order-head"><span>${o.order_no}・${src}</span><span>${o.total} 元</span></div>
      <div class="order-meta">${STATUS_LABEL[o.status]} ・ ${o.created_at} ・ ${payTag}${o.pickup_phone ? ' ・ ' + o.pickup_phone : ''}${o.pickup_time ? '・預計 ' + o.pickup_time : ''}</div>
      <div class="order-items">${itemsHtml}${o.note ? `<br>備註：${o.note}` : ''}</div>
      <div class="order-actions">
        ${o.status === 'received' ? '<button data-status="preparing">開始製作</button>' : ''}
        ${o.status === 'preparing' ? '<button data-status="done">完成</button>' : ''}
        ${o.status !== 'cancelled' && o.status !== 'done' ? '<button data-status="cancelled">取消</button>' : ''}
        <button data-print class="primary">列印廚房單</button>
        ${!o.paid ? '<button data-checkout>結帳</button>' : ''}
      </div>
    </div>
  `;
}

async function updateStatus(id, status) {
  await fetch(`/api/staff/orders/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  loadOrders();
}

async function checkout(id) {
  const method = confirm('按「確定」＝現金收款\n按「取消」再選是否為刷卡') ? 'cash' : (confirm('這筆是刷卡收款嗎？') ? 'card' : null);
  if (!method) return;
  await fetch(`/api/staff/orders/${id}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_method: method }),
  });
  loadOrders();
  loadSummary();
}

// ---------- 商品管理 ----------
async function loadProducts() {
  const res = await fetch('/api/staff/products');
  const products = await res.json();
  const el = document.getElementById('productsTab');
  el.innerHTML = `
    <button id="addProductBtn" class="order-actions" style="margin-bottom:10px;padding:8px 14px;border:none;border-radius:6px;background:#7a2e1d;color:#fff;">＋ 新增商品</button>
    ${products.map(renderProductRow).join('')}
  `;
  document.getElementById('addProductBtn').onclick = () => addProduct();
  products.forEach((p) => {
    const row = document.getElementById(`product-${p.id}`);
    row.querySelector('[data-save]').onclick = () => saveProduct(p.id, row);
    row.querySelector('[data-remove]').onclick = () => removeProduct(p.id);
  });
}

function renderProductRow(p) {
  return `
    <div class="order-card" id="product-${p.id}">
      <div class="order-actions" style="flex-wrap:wrap;">
        <input data-field="name" value="${p.name}" style="flex:2;padding:6px;">
        <input data-field="price" type="number" value="${p.price}" style="width:80px;padding:6px;">
        <input data-field="category" value="${p.category}" style="width:90px;padding:6px;">
        <label style="display:flex;align-items:center;gap:4px;"><input data-field="available" type="checkbox" ${p.available ? 'checked' : ''}>上架</label>
        <button data-save class="primary">儲存</button>
        <button data-remove>下架刪除</button>
      </div>
    </div>
  `;
}

async function saveProduct(id, row) {
  const name = row.querySelector('[data-field="name"]').value;
  const price = Number(row.querySelector('[data-field="price"]').value);
  const category = row.querySelector('[data-field="category"]').value;
  const available = row.querySelector('[data-field="available"]').checked;
  await fetch(`/api/staff/products/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, price, category, available, sort_order: 0 }),
  });
  loadProducts();
}

async function removeProduct(id) {
  if (!confirm('確定要下架這個商品嗎？')) return;
  await fetch(`/api/staff/products/${id}`, { method: 'DELETE' });
  loadProducts();
}

async function addProduct() {
  const name = prompt('商品名稱？');
  if (!name) return;
  const price = Number(prompt('價格？', '0'));
  const category = prompt('分類？（例如 麵食／滷味）', '其他');
  await fetch('/api/staff/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, price, category, sort_order: 0 }),
  });
  loadProducts();
}

checkLogin();
