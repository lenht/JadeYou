/* Jade You — cart engine
   Cart state lives in localStorage so it persists across pages and visits.
   Each page sets `window.SITE_PREFIX` ("" at the root, "../" one level down)
   before this file loads, so links/assets resolve correctly from any page. */

(function(){
  const PREFIX = window.SITE_PREFIX || '';
  const STORAGE_KEY = 'jadeyou_cart_v1';

  function fmt(n){
    return 'HK$' + Number(n).toLocaleString('en-US');
  }

  const Cart = {
    get(){
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch(e){ return []; }
    },
    save(items){
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch(e){}
      Cart.render();
    },
    add(item, qty){
      qty = qty || 1;
      const items = Cart.get();
      const existing = items.find(i => i.slug === item.slug);
      if (existing) { existing.qty += qty; }
      else { items.push(Object.assign({}, item, { qty: qty })); }
      Cart.save(items);
    },
    updateQty(slug, qty){
      let items = Cart.get();
      if (qty <= 0) { items = items.filter(i => i.slug !== slug); }
      else { items.forEach(i => { if (i.slug === slug) i.qty = qty; }); }
      Cart.save(items);
    },
    remove(slug){
      const items = Cart.get().filter(i => i.slug !== slug);
      Cart.save(items);
    },
    count(){
      return Cart.get().reduce((sum, i) => sum + i.qty, 0);
    },
    subtotal(){
      return Cart.get().reduce((sum, i) => sum + i.qty * i.price, 0);
    },
    clear(){
      Cart.save([]);
    },
    lineHTML(item, opts){
      opts = opts || {};
      const removable = opts.removable !== false;
      const stepper = opts.stepper !== false;
      return `
        <div class="${opts.rowClass || 'cart-line'}" data-slug="${item.slug}">
          <div class="ci-image ${item.tone}"><svg viewBox="0 0 48 48" fill="none" stroke-width="1.3">${item.icon}</svg></div>
          <div class="${opts.bodyClass || 'ci-body'}">
            <div class="ci-ref">${item.ref}</div>
            <h4>${item.name}</h4>
            ${opts.showPrice !== false ? `<div class="ci-price">${fmt(item.price)}</div>` : ''}
            ${stepper ? `
            <div class="ci-row">
              <div class="qty-stepper">
                <button type="button" class="qty-dec" aria-label="Decrease quantity">&minus;</button>
                <span>${item.qty}</span>
                <button type="button" class="qty-inc" aria-label="Increase quantity">&plus;</button>
              </div>
              ${removable ? `<button type="button" class="ci-remove">Remove</button>` : ''}
            </div>` : `<div class="ol-meta">Qty ${item.qty} &middot; ${fmt(item.qty*item.price)}</div>`}
          </div>
        </div>`;
    },
    render(){
      const items = Cart.get();
      const count = Cart.count();

      // badges
      document.querySelectorAll('.cart-badge').forEach(b => {
        b.textContent = count;
        b.classList.toggle('hidden', count === 0);
      });

      // drawer
      const drawerBody = document.getElementById('cartItems');
      const drawerFoot = document.getElementById('cartDrawerFoot');
      if (drawerBody) {
        if (items.length === 0) {
          drawerBody.innerHTML = `<div class="cart-empty">Your reservation list is empty.<br><a href="${PREFIX}index.html#collections">Explore the Collections</a></div>`;
          if (drawerFoot) drawerFoot.style.display = 'none';
        } else {
          drawerBody.innerHTML = items.map(i => Cart.lineHTML(i)).join('');
          if (drawerFoot) drawerFoot.style.display = 'block';
          const subtotalEl = document.getElementById('cartSubtotal');
          if (subtotalEl) subtotalEl.textContent = fmt(Cart.subtotal());
        }
      }

      // checkout page
      const orderItems = document.getElementById('orderItems');
      if (orderItems) {
        if (items.length === 0) {
          document.getElementById('checkoutEmpty').style.display = 'block';
          document.getElementById('checkoutFull').style.display = 'none';
        } else {
          document.getElementById('checkoutEmpty').style.display = 'none';
          document.getElementById('checkoutFull').style.display = 'grid';
          orderItems.innerHTML = items.map(i => Cart.lineHTML(i, {rowClass:'order-line', bodyClass:'ol-body', stepper:false})).join('');
          const sub = Cart.subtotal();
          document.getElementById('orderSubtotal').textContent = fmt(sub);
          document.getElementById('orderTotal').textContent = fmt(sub);
        }
      }
    }
  };

  window.Cart = Cart;

  document.addEventListener('DOMContentLoaded', function(){
    Cart.render();

    // drawer open/close
    const overlay = document.getElementById('cartOverlay');
    const drawer = document.getElementById('cartDrawer');
    function openDrawer(){ if(overlay&&drawer){ overlay.classList.add('open'); drawer.classList.add('open'); } }
    function closeDrawer(){ if(overlay&&drawer){ overlay.classList.remove('open'); drawer.classList.remove('open'); } }
    document.querySelectorAll('.cart-toggle').forEach(btn => btn.addEventListener('click', openDrawer));
    const closeBtn = document.getElementById('cartDrawerClose');
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (overlay) overlay.addEventListener('click', closeDrawer);

    // delegated qty/remove handlers inside the drawer
    const drawerBody = document.getElementById('cartItems');
    if (drawerBody) {
      drawerBody.addEventListener('click', function(e){
        const row = e.target.closest('[data-slug]');
        if (!row) return;
        const slug = row.getAttribute('data-slug');
        const item = Cart.get().find(i => i.slug === slug);
        if (!item) return;
        if (e.target.classList.contains('qty-inc')) Cart.updateQty(slug, item.qty + 1);
        if (e.target.classList.contains('qty-dec')) Cart.updateQty(slug, item.qty - 1);
        if (e.target.classList.contains('ci-remove')) Cart.remove(slug);
      });
    }

    // "Add to Reservation" button on product detail pages
    const addBtn = document.getElementById('addToCartBtn');
    if (addBtn) {
      addBtn.addEventListener('click', function(){
        const data = JSON.parse(addBtn.getAttribute('data-item'));
        const qtyInput = document.getElementById('reserveQty');
        const qty = qtyInput ? Math.max(1, parseInt(qtyInput.value, 10) || 1) : 1;
        Cart.add(data, qty);
        openDrawer();
      });
    }
    const qtyDecBtn = document.getElementById('reserveQtyDec');
    const qtyIncBtn = document.getElementById('reserveQtyInc');
    const qtyInputEl = document.getElementById('reserveQty');
    if (qtyDecBtn && qtyInputEl) qtyDecBtn.addEventListener('click', () => { qtyInputEl.value = Math.max(1, (parseInt(qtyInputEl.value,10)||1) - 1); });
    if (qtyIncBtn && qtyInputEl) qtyIncBtn.addEventListener('click', () => { qtyInputEl.value = (parseInt(qtyInputEl.value,10)||1) + 1; });

    // payment option selection styling
    document.querySelectorAll('.payment-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.payment-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        opt.querySelector('input[type=radio]').checked = true;
      });
    });
    const firstPayment = document.querySelector('.payment-option');
    if (firstPayment) firstPayment.classList.add('selected');

    // checkout submit -> submits the reservation through the
    // submit-advisor-order Edge Function (reserves real stock, creates a
    // real pending order), falling back to the mailto: draft only if that
    // call itself fails (e.g. Supabase unreachable) so a customer's
    // request is never simply lost.
    const checkoutForm = document.getElementById('checkoutForm');
    if (checkoutForm) {
      checkoutForm.addEventListener('submit', async function(e){
        e.preventDefault();
        const items = Cart.get();
        if (items.length === 0) return;
        const name = document.getElementById('coName').value;
        const email = document.getElementById('coEmail').value;
        const phone = document.getElementById('coPhone').value;
        const address = document.getElementById('coAddress').value;
        const payment = document.querySelector('input[name="payment"]:checked');
        const paymentValue = payment ? payment.value : 'bank_transfer';
        const paymentLabels = { bank_transfer: 'Bank Transfer', invoice: 'Request Invoice', in_person: 'Pay In Person at Atelier' };

        const submitBtn = checkoutForm.querySelector('.checkout-submit');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

        function mailtoFallback(){
          const lines = items.map(i => `  • ${i.name} (${i.ref}) × ${i.qty} — ${fmt(i.price*i.qty)}`).join('\n');
          const subtotal = fmt(Cart.subtotal());
          const subject = encodeURIComponent('Reservation Request — ' + items.map(i=>i.ref).join(', '));
          const body = encodeURIComponent(
            `Hello Jade You,\n\nI would like to reserve the following piece(s):\n\n${lines}\n\nSubtotal: ${subtotal}\n\nPreferred payment method: ${paymentLabels[paymentValue] || paymentValue}\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nDelivery / Appointment Address: ${address}\n\nPlease confirm availability and final total, and advise next steps to complete payment.`
          );
          window.location.href = 'mailto:hello@jadeyou.com?subject=' + subject + '&body=' + body;
        }

        try {
          const res = await fetch(`${window.SUPABASE_FUNCTIONS_URL}/submit-advisor-order`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + window.SUPABASE_ANON_KEY,
              'apikey': window.SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({
              items: items.map(i => ({ slug: i.slug, quantity: i.qty })),
              guestName: name,
              guestEmail: email,
              guestPhone: phone,
              deliveryAddress: { notes: address },
              paymentMethod: paymentValue,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Request failed');

          document.getElementById('checkoutFull').style.display = 'none';
          document.getElementById('checkoutConfirm').classList.add('show');
          Cart.clear();
        } catch (err) {
          console.error('submit-advisor-order failed, falling back to email:', err);
          mailtoFallback();
          document.getElementById('checkoutFull').style.display = 'none';
          document.getElementById('checkoutConfirm').classList.add('show');
          Cart.clear();
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Reservation Request'; }
        }
      });
    }
  });
})();
