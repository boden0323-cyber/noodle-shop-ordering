const params = new URLSearchParams(location.search);
const tableNo = params.get('table'); // 有 table 參數 = 內用掃碼點餐；沒有 = 線上預購取貨
const mode = tableNo ? 'dine_in' : 'pickup';

document.getElementById('modeBadge').textContent = tableNo ? `內用點餐・${tableNo}桌` : '線上預購取貨';

const CATEGORY_ICON = { 麵食: '🍜', 湯品: '🥣', 滷味: '🍢' };

let products = [];
const cart = new Map(); // product_id -> { product, qty }

async function loadProducts() {
  const res = await fetch('/api/products');
  products = await res.json();
  renderCategoryNav();
  renderMenu();
}

function groupByCategory() {
  const byCategory = {};
  for (const p of products) {
    (byCategory[p.category] = byCategory[p.category] || []).push(p);
  }
  return byCategory;
}

function renderCategoryNav() {
  const byCategory = groupByCategory();
  const nav = document.getElementById('categoryNav');
  nav.innerHTML = Object.keys(byCategory)
    .map((cat, i) => `<button data-cat="${cat}" class="${i === 0 ? 'active' : ''}">${CATEGORY_ICON[cat] || ''} ${cat}</button>`)
    .join('');
  nav.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      document.getElementById(`section-${btn.dataset.cat}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
}

function renderMenu() {
  const byCategory = groupByCategory();
  const menuEl = document.getElementById('menu');
  menuEl.innerHTML = Object.entries(byCategory)
    .map(([category, items]) => `
      <section class="category-section" id="section-${category}">
        <div class="category-title"><span class="icon">${CATEGORY_ICON[category] || ''}</span>${category}</div>
        ${items.map(renderProductCardHTML).join('')}
      </section>
    `).join('');

  menuEl.querySelectorAll('.product-card').forEach((card) => {
    const id = Number(card.dataset.id);
    const product = products.find((p) => p.id === id);
    card.querySelector('.inc').onclick = () => changeQty(product, 1);
    card.querySelector('.dec').onclick = () => changeQty(product, -1);
  });

  setupScrollSpy();
}

function renderProductCardHTML(p) {
  const qty = cart.get(p.id)?.qty || 0;
  return `
    <div class="product-card ${qty > 0 ? 'in-cart' : ''}" data-id="${p.id}">
      <div>
        <div class="product-name">${p.name}</div>
        <div class="product-price">${p.price} 元</div>
      </div>
      <div class="qty-control">
        <button class="dec">－</button>
        <span>${qty}</span>
        <button class="inc">＋</button>
      </div>
    </div>
  `;
}

function changeQty(p, delta) {
  const cur = cart.get(p.id)?.qty || 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) cart.delete(p.id);
  else cart.set(p.id, { product: p, qty: next });
  renderMenu();
  renderCartBar();
}

function setupScrollSpy() {
  const sections = [...document.querySelectorAll('.category-section')];
  const navButtons = [...document.querySelectorAll('.category-nav button')];
  const onScroll = () => {
    let current = sections[0];
    for (const s of sections) {
      if (s.getBoundingClientRect().top - 70 <= 0) current = s;
    }
    navButtons.forEach((b) => b.classList.toggle('active', current && b.dataset.cat === current.id.replace('section-', '')));
  };
  window.removeEventListener('scroll', window.__scrollSpy || (() => {}));
  window.__scrollSpy = onScroll;
  window.addEventListener('scroll', onScroll, { passive: true });
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
      <button type="submit">確認送出訂單</button>
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
  document.querySelector('.category-nav').style.display = 'none';
  document.querySelector('main').innerHTML = `
    <div class="confirm-box">
      <div class="check">✅</div>
      <h2>訂單已送出</h2>
      <div class="order-no">${data.order_no}</div>
      <div class="amount">金額 ${data.total} 元，請於${mode === 'dine_in' ? '現場' : '取貨時'}付款</div>
    </div>
  `;
  document.querySelector('.cart-bar').style.display = 'none';
}

loadProducts();
