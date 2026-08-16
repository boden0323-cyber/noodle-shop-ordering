const params = new URLSearchParams(location.search);
const tableNo = params.get('table'); // 有 table 參數 = 內用掃碼點餐；沒有 = 線上預購取貨
const mode = tableNo ? 'dine_in' : 'pickup';

document.getElementById('pageTitle').textContent = tableNo ? `內用點餐（${tableNo}桌）` : '滷味預購取貨';

let products = [];
const cart = new Map(); // product_id -> { product, qty }

async function loadProducts() {
  const res = await fetch('/api/products');
  products = await res.json();
  renderMenu();
}

function renderMenu() {
  const byCategory = {};
  for (const p of products) {
    (byCategory[p.category] = byCategory[p.category] || []).push(p);
  }
  const menuEl = document.getElementById('menu');
  menuEl.innerHTML = '';
  for (const [category, items] of Object.entries(byCategory)) {
    const title = document.createElement('div');
    title.className = 'category-title';
    title.textContent = category;
    menuEl.appendChild(title);
    for (const p of items) {
      menuEl.appendChild(renderProductCard(p));
    }
  }
}

function renderProductCard(p) {
  const card = document.createElement('div');
  card.className = 'product-card';
  const qty = cart.get(p.id)?.qty || 0;
  card.innerHTML = `
    <div>
      <div class="product-name">${p.name}</div>
      <div class="product-price">${p.price} 元</div>
    </div>
    <div class="qty-control">
      <button data-action="dec">－</button>
      <span>${qty}</span>
      <button data-action="inc">＋</button>
    </div>
  `;
  card.querySelector('[data-action="inc"]').onclick = () => changeQty(p, 1);
  card.querySelector('[data-action="dec"]').onclick = () => changeQty(p, -1);
  return card;
}

function changeQty(p, delta) {
  const cur = cart.get(p.id)?.qty || 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) cart.delete(p.id);
  else cart.set(p.id, { product: p, qty: next });
  renderMenu();
  renderCartBar();
}

function renderCartBar() {
  let count = 0, total = 0;
  for (const { product, qty } of cart.values()) {
    count += qty;
    total += qty * product.price;
  }
  document.getElementById('cartCount').textContent = count;
  document.getElementById('cartTotal').textContent = total;
  document.getElementById('submitBtn').disabled = count === 0;
}

document.getElementById('submitBtn').onclick = () => {
  if (mode === 'pickup') showPickupForm();
  else submitOrder({ type: 'dine_in', table_no: tableNo });
};

function showPickupForm() {
  const main = document.querySelector('main');
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <form class="info-form" id="pickupForm">
      <h3>留一下取貨資訊</h3>
      <label>姓名<input required name="pickup_name"></label>
      <label>電話<input required name="pickup_phone" type="tel"></label>
      <label>希望取貨時間<input name="pickup_time" placeholder="例如 8/20 18:00"></label>
      <label>備註（口味需求等）<input name="note"></label>
      <button type="submit" style="width:100%;padding:10px;background:#7a2e1d;color:#fff;border:none;border-radius:8px;">確認送出訂單</button>
    </form>
  `;
  main.appendChild(wrap);
  wrap.scrollIntoView({ behavior: 'smooth' });
  document.getElementById('pickupForm').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    submitOrder({
      type: 'pickup',
      pickup_name: fd.get('pickup_name'),
      pickup_phone: fd.get('pickup_phone'),
      pickup_time: fd.get('pickup_time'),
      note: fd.get('note'),
    });
  };
}

async function submitOrder(extra) {
  const items = [...cart.values()].map(({ product, qty }) => ({ product_id: product.id, qty }));
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...extra, items }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '送出失敗，請再試一次');
    return;
  }
  document.querySelector('main').innerHTML = `
    <div class="info-form" style="text-align:center;">
      <h2>訂單已送出 ✅</h2>
      <p style="font-size:20px;">單號 ${data.order_no}</p>
      <p>金額 ${data.total} 元，請於${mode === 'dine_in' ? '現場' : '取貨時'}付款</p>
    </div>
  `;
  document.querySelector('.cart-bar').style.display = 'none';
}

loadProducts();
