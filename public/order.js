const params = new URLSearchParams(location.search);
const tableNo = params.get('table'); // 有 table 參數 = 內用掃碼點餐，直接鎖定，不用再選
let mode = tableNo ? 'dine_in' : null; // null = 還沒選（內用/外帶/預購三選一）
let manualTableNo = '';

const CATEGORY_ICON = { 麵食: '🍲', 湯品: '🥣', 滷味: '🍖' };
const CATEGORY_ORDER = ['麵食', '滷味', '湯品'];

updateModeBadge();
if (!tableNo) renderTypeSelector();

// LINE內建瀏覽器常有相容性問題，偵測到就提示客人改用手機預設瀏覽器開啟
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

function updateModeBadge() {
  const label = { dine_in: `內用點餐${tableNo ? '・' + tableNo + '桌' : ''}`, takeout: '外帶', pickup: '線上預購取貨' };
  document.getElementById('modeBadge').textContent = mode ? label[mode] : '請選擇取餐方式';
}

// ---------- 取餐方式三選一（沒掃桌號QR才會顯示） ----------
function renderTypeSelector() {
  const el = document.getElementById('typeSelector');
  el.innerHTML = `
    <div class="type-selector">
      <button data-type="dine_in" class="${mode === 'dine_in' ? 'active' : ''}">🍽️ 內用</button>
      <button data-type="takeout" class="${mode === 'takeout' ? 'active' : ''}">🥡 外帶</button>
      <button data-type="pickup" class="${mode === 'pickup' ? 'active' : ''}">📅 預購取貨</button>
    </div>
    ${mode === 'dine_in' ? `<div class="inline-field"><input id="manualTableInput" placeholder="請輸入桌號，例如 A3" value="${manualTableNo}"></div>` : ''}
  `;
  el.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      mode = btn.dataset.type;
      updateModeBadge();
      renderTypeSelector();
      if (mode === 'dine_in') setTimeout(() => document.getElementById('manualTableInput')?.focus(), 50);
    };
  });
  const input = document.getElementById('manualTableInput');
  if (input) input.oninput = (e) => { manualTableNo = e.target.value; };
}

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
  const sorted = {};
  const keys = Object.keys(byCategory).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  for (const k of keys) sorted[k] = byCategory[k];
  return sorted;
}

function renderCategoryNav() {
  const byCategory = groupByCategory();
  const nav = document.getElementById('categoryNav');
  nav.innerHTML = Object.keys(byCategory)
    .map((cat, i) => `<button data-cat="${cat}" class="${i === 0 ? 'active' : ''}">${CATEGORY_ICON[cat] || ''} ${cat}</button>`)
    .join('');
  nav.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      const target = document.getElementById(`section-${btn.dataset.cat}`);
      const top = target.getBoundingClientRect().top + window.scrollY - 54;
      window.scrollTo({ top, behavior: 'smooth' });
      const startY = window.scrollY;
      setTimeout(() => { if (Math.abs(window.scrollY - startY) < 10) window.scrollTo({ top }); }, 300);
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
  renderMiniCart();
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

// ---------- 快速購物車預覽（不用捲回頂部就能看/改已加的品項） ----------
let miniCartOpen = false;
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

document.getElementById('cartSummary').onclick = () => {
  if (cart.size === 0) return;
  miniCartOpen = !miniCartOpen;
  renderMiniCart();
};

function renderMiniCart() {
  const el = document.getElementById('miniCart');
  if (!miniCartOpen || cart.size === 0) { el.classList.remove('open'); el.innerHTML = ''; return; }
  el.classList.add('open');
  el.innerHTML = [...cart.values()].map(({ product, qty }) => `
    <div class="mini-cart-row">
      <span>${product.name}</span>
      <div class="qty-control">
        <button class="dec" data-id="${product.id}">－</button>
        <span>${qty}</span>
        <button class="inc" data-id="${product.id}">＋</button>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('.inc').forEach((b) => b.onclick = () => changeQty(products.find(p => p.id === Number(b.dataset.id)), 1));
  el.querySelectorAll('.dec').forEach((b) => b.onclick = () => changeQty(products.find(p => p.id === Number(b.dataset.id)), -1));
}

// ---------- 送出訂單 ----------
document.getElementById('submitBtn').onclick = () => {
  if (!mode) {
    document.querySelector('.type-selector')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashTypeSelector();
    return;
  }
  if (mode === 'dine_in' && tableNo) {
    submitOrder({ type: 'dine_in', table_no: tableNo });
    return;
  }
  if (mode === 'dine_in' && !tableNo) {
    if (!manualTableNo.trim()) {
      document.getElementById('manualTableInput')?.focus();
      flashTypeSelector();
      return;
    }
    submitOrder({ type: 'dine_in', table_no: manualTableNo.trim() });
    return;
  }
  if (mode === 'takeout') { showContactForm('takeout'); return; }
  if (mode === 'pickup') { showContactForm('pickup'); return; }
};

function flashTypeSelector() {
  const box = document.querySelector('.type-selector');
  if (!box) return;
  box.style.boxShadow = '0 0 0 3px #c0392b';
  setTimeout(() => { box.style.boxShadow = ''; }, 900);
}

function showContactForm(type) {
  document.getElementById('miniCart').classList.remove('open');
  miniCartOpen = false;
  const main = document.querySelector('main');
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <form class="info-form" id="contactForm">
      <h3>${type === 'takeout' ? '外帶資訊' : '預購取貨資訊'}</h3>
      <label>姓名<input required name="pickup_name" autofocus></label>
      <label>電話<input required name="pickup_phone" type="tel" inputmode="numeric"></label>
      ${type === 'pickup' ? '<label>希望取貨時間<input name="pickup_time" placeholder="例如 8/25 18:00"></label>' : ''}
      <label>備註（口味需求等，選填）<input name="note"></label>
      <button type="submit">確認送出訂單</button>
    </form>
  `;
  main.appendChild(wrap);
  wrap.scrollIntoView({ behavior: 'smooth' });
  document.getElementById('contactForm').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    submitOrder({
      type,
      pickup_name: fd.get('pickup_name'),
      pickup_phone: fd.get('pickup_phone'),
      pickup_time: fd.get('pickup_time') || '',
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

  // 記到本機，方便之後回來查詢自己點過什麼
  try {
    const mine = JSON.parse(localStorage.getItem('myOrders') || '[]');
    mine.push({ id: data.order_id, order_no: data.order_no, total: data.total, time: Date.now() });
    localStorage.setItem('myOrders', JSON.stringify(mine.slice(-10)));
  } catch {}

  document.querySelector('.category-nav').style.display = 'none';
  document.getElementById('typeSelector').style.display = 'none';
  document.getElementById('miniCart').style.display = 'none';
  document.querySelector('main').innerHTML = `
    <div class="confirm-box">
      <div class="check">✅</div>
      <h2>訂單已送出</h2>
      <div class="order-no">${data.order_no}</div>
      <div class="amount">金額 ${data.total} 元，請於${extra.type === 'dine_in' ? '現場' : '取貨時'}付款</div>
      <a href="order-status.html?id=${data.order_id}" style="display:inline-block;margin-top:16px;color:#7a2e1d;font-weight:700;text-decoration:none;border:1px solid #7a2e1d;border-radius:999px;padding:9px 22px;">查看訂單狀態 →</a>
    </div>
  `;
  document.querySelector('.cart-bar').style.display = 'none';
}

loadProducts();
