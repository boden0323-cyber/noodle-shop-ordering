const STATUS_LABEL = { received: '已收到訂單，等待製作', preparing: '製作中', done: '已完成，可以取餐囉', cancelled: '此訂單已取消' };
const params = new URLSearchParams(location.search);
const orderId = params.get('id');

function getMyOrders() {
  try { return JSON.parse(localStorage.getItem('myOrders') || '[]'); } catch { return []; }
}

async function main() {
  const content = document.getElementById('content');
  if (!orderId) {
    renderMyOrdersList(content);
    return;
  }
  await renderSingleOrder(content, orderId);
  setInterval(() => renderSingleOrder(content, orderId, true), 8000); // 每8秒自動更新狀態
}

function renderMyOrdersList(content) {
  const orders = getMyOrders();
  if (orders.length === 0) {
    content.innerHTML = `<div class="empty-hint">還沒有訂單紀錄<br>去<a href="order.html">點餐頁</a>逛逛吧</div>`;
    return;
  }
  content.innerHTML = `
    <div class="confirm-box" style="text-align:left;padding:20px;">
      <h3 style="color:#7a2e1d;margin-top:0;">我的訂單紀錄</h3>
      ${orders.slice().reverse().map((o) => `
        <a href="order-status.html?id=${o.id}" style="display:block;padding:12px 0;border-bottom:1px solid #f0e6d6;text-decoration:none;color:inherit;">
          <b style="color:#7a2e1d;">${o.order_no}</b>　${o.total}元
          <div style="font-size:12px;color:#998;">${new Date(o.time).toLocaleString('zh-TW')}</div>
        </a>
      `).join('')}
    </div>
  `;
}

async function renderSingleOrder(content, id, silent) {
  const res = await fetch(`/api/orders/${id}`);
  if (!res.ok) {
    content.innerHTML = `<div class="empty-hint">找不到這筆訂單，可能編號有誤</div>`;
    return;
  }
  const o = await res.json();
  const typeLabel = { dine_in: `內用・${o.table_no}桌`, takeout: '外帶', pickup: '線上預購取貨' };

  content.innerHTML = `
    <div class="confirm-box">
      <div class="order-no">${o.order_no}</div>
      <div style="font-size:15px;color:#666;margin-bottom:14px;">${typeLabel[o.type] || o.type}</div>
      <div style="display:inline-block;background:#f7ede0;color:#7a2e1d;padding:8px 18px;border-radius:999px;font-weight:700;margin-bottom:18px;">
        ${STATUS_LABEL[o.status] || o.status}
      </div>
      <div style="text-align:left;background:#fdfbf6;border-radius:12px;padding:14px 16px;margin-bottom:14px;">
        ${o.items.map((it) => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;"><span>${it.product_name} x${it.qty}${it.note ? `（${it.note}）` : ''}</span><span>${it.price * it.qty}元</span></div>`).join('')}
      </div>
      <div class="amount"><b>合計 ${o.total} 元</b>　${o.paid ? '（已收款）' : '（尚未付款）'}</div>
      ${o.pickup_time ? `<div class="amount">希望取貨時間：${o.pickup_time}</div>` : ''}
    </div>
  `;
}

main();
