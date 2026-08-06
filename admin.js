/* Jade You — Admin Panel logic.

   Talks to Supabase directly with the anon key + Supabase Auth (never the
   service_role key — this file ships to the browser, same as the rest of
   the site). Every read/write here only succeeds because of the RLS
   policies and admin_* functions added in jade-you-admin-schema.sql; if
   that migration hasn't been run, or the signed-in user has no matching
   row in `admins`, every call below simply fails closed.

   Money-moving actions (confirming an advisor payment, recording a
   refund) go through admin_mark_order_paid() / admin_record_refund()
   rather than raw table writes — see the schema file for why. */

(function () {
  const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  const fmt = (cents) => 'HK$' + (Number(cents || 0)).toLocaleString('en-US');
  const dollarsToCents = (v) => Math.round(Number(v || 0) * 100);
  const centsToDollars = (c) => (Number(c || 0) / 100).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  let categories = [];
  let currentOrders = [];

  // ---------------------------------------------------------------------
  // toast
  // ---------------------------------------------------------------------
  function toast(message, isError) {
    const el = document.getElementById('adminToast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---------------------------------------------------------------------
  // auth
  // ---------------------------------------------------------------------
  async function attemptLogin(email, password) {
    const errEl = document.getElementById('loginError');
    errEl.classList.remove('show');
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing In…';

    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await enterAdmin();
    } catch (err) {
      errEl.textContent = err.message || 'Sign in failed.';
      errEl.classList.add('show');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }

  async function enterAdmin() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showLogin();

    const { data: isAdminData, error } = await sb.rpc('is_admin');
    if (error || !isAdminData) {
      document.getElementById('loginError').textContent =
        'This account is signed in but is not registered as a Jade You admin. Add it to the admins table first.';
      document.getElementById('loginError').classList.add('show');
      await sb.auth.signOut();
      return showLogin();
    }

    document.getElementById('adminWho').textContent = session.user.email;
    document.getElementById('adminLogin').style.display = 'none';
    document.getElementById('adminShell').classList.add('show');

    await Promise.all([loadCategories(), loadDashboard()]);
    switchTab('dashboard');
  }

  function showLogin() {
    document.getElementById('adminShell').classList.remove('show');
    document.getElementById('adminLogin').style.display = 'flex';
  }

  async function signOut() {
    await sb.auth.signOut();
    showLogin();
  }

  // ---------------------------------------------------------------------
  // tabs
  // ---------------------------------------------------------------------
  function switchTab(tab) {
    document.querySelectorAll('.admin-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.admin-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
    if (tab === 'dashboard') loadDashboard();
    if (tab === 'products') loadProducts();
    if (tab === 'categories') renderCategories();
    if (tab === 'orders') loadOrders();
    if (tab === 'enquiries') loadEnquiries();
  }

  // ---------------------------------------------------------------------
  // dashboard
  // ---------------------------------------------------------------------
  async function loadDashboard() {
    const wrap = document.getElementById('dashboardStats');
    wrap.innerHTML = '<div class="admin-loading">Loading dashboard…</div>';

    const [{ data: stats, error: statsErr }, { data: lowStock, error: stockErr }] = await Promise.all([
      sb.rpc('admin_order_stats'),
      sb.rpc('admin_low_stock_products', { p_threshold: 0 }),
    ]);

    if (statsErr) {
      wrap.innerHTML = '<div class="admin-empty">Could not load stats: ' + esc(statsErr.message) + '</div>';
      return;
    }

    const s = stats[0] || {};
    const cards = [
      ['Total Orders', s.total_orders, true],
      ['Revenue (Paid)', fmt(s.revenue_paid_cents), true],
      ['Pending Payment', s.pending_payment],
      ['Paid', s.paid],
      ['Failed', s.failed_payment],
      ['Refunded', (Number(s.refunded || 0) + Number(s.partially_refunded || 0))],
      ['Fulfillment: Pending', s.fulfillment_pending],
      ['Processing', s.processing],
      ['Ready for Collection', s.ready_for_collection],
      ['Shipped', s.shipped],
      ['Delivered', s.delivered],
      ['Cancelled', s.cancelled],
    ];

    wrap.innerHTML = cards.map(([label, val, wide]) =>
      `<div class="admin-stat-card${wide ? ' wide' : ''}"><div class="num">${esc(val ?? 0)}</div><div class="lbl">${esc(label)}</div></div>`
    ).join('');

    const stockWrap = document.getElementById('lowStockList');
    if (stockErr) {
      stockWrap.innerHTML = '<div class="admin-empty">Could not load stock levels.</div>';
    } else if (!lowStock || lowStock.length === 0) {
      stockWrap.innerHTML = '<div class="admin-empty">Nothing is sold out right now.</div>';
    } else {
      stockWrap.innerHTML =
        '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Product</th><th>Total Stocked</th><th>Available Now</th></tr></thead><tbody>' +
        lowStock.map((p) => `<tr><td>${esc(p.name)} <span class="admin-mono">(${esc(p.slug)})</span></td><td>${esc(p.quantity_total)}</td><td>${esc(p.available)}</td></tr>`).join('') +
        '</tbody></table></div>';
    }
  }

  // ---------------------------------------------------------------------
  // categories
  // ---------------------------------------------------------------------
  async function loadCategories() {
    const { data, error } = await sb.from('categories').select('*').order('sort_order');
    if (error) { toast('Could not load categories: ' + error.message, true); return; }
    categories = data || [];
    populateCategorySelects();
  }

  function populateCategorySelects() {
    document.querySelectorAll('.category-select').forEach((sel) => {
      const current = sel.value;
      sel.innerHTML = categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      if (current) sel.value = current;
    });
  }

  function renderCategories() {
    const wrap = document.getElementById('categoriesList');
    if (categories.length === 0) { wrap.innerHTML = '<div class="admin-empty">No categories found.</div>'; return; }

    wrap.innerHTML = categories.map((c) => `
      <div class="admin-card" data-cat-id="${c.id}">
        <h3>${esc(c.name)} <span class="admin-mono">/${esc(c.slug)}</span></h3>
        <div class="admin-form-row">
          <div class="admin-field"><label>Name</label><input class="cat-name" value="${esc(c.name)}"></div>
          <div class="admin-field"><label>Sort Order</label><input class="cat-sort" type="number" value="${esc(c.sort_order)}"></div>
          <div class="admin-field full"><label>Description</label><textarea class="cat-desc">${esc(c.description || '')}</textarea></div>
        </div>
        <div class="admin-form-actions">
          <button class="admin-btn admin-btn-sm cat-save">Save Changes</button>
        </div>
      </div>
    `).join('');

    wrap.querySelectorAll('.cat-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.admin-card');
        const id = card.dataset.catId;
        const fields = {
          name: card.querySelector('.cat-name').value.trim(),
          sort_order: parseInt(card.querySelector('.cat-sort').value, 10) || 0,
          description: card.querySelector('.cat-desc').value.trim(),
        };
        const { error } = await sb.from('categories').update(fields).eq('id', id);
        if (error) { toast('Save failed: ' + error.message, true); return; }
        toast('Category saved.');
        await loadCategories();
      });
    });
  }

  // ---------------------------------------------------------------------
  // products
  // ---------------------------------------------------------------------
  async function loadProducts() {
    const wrap = document.getElementById('productsTableWrap');
    wrap.innerHTML = '<div class="admin-loading">Loading products…</div>';

    const { data, error } = await sb
      .from('products')
      .select('id, slug, reference_sku, name, price_cents, quantity_total, is_active, category_id, categories(name)')
      .order('created_at', { ascending: false });

    if (error) { wrap.innerHTML = '<div class="admin-empty">Could not load products: ' + esc(error.message) + '</div>'; return; }
    if (!data || data.length === 0) { wrap.innerHTML = '<div class="admin-empty">No products yet. Add your first one below.</div>'; return; }

    wrap.innerHTML =
      '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>' +
      '<th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' +
      data.map((p) => `
        <tr>
          <td>${esc(p.name)}<br><span class="admin-mono">${esc(p.slug)}</span></td>
          <td class="admin-mono">${esc(p.reference_sku)}</td>
          <td>${esc(p.categories ? p.categories.name : '—')}</td>
          <td>${p.price_cents == null ? '<em>Contact for price</em>' : esc(fmt(p.price_cents))}</td>
          <td>${esc(p.quantity_total)}</td>
          <td><span class="admin-badge ${p.is_active ? 'badge-active' : 'badge-inactive'}">${p.is_active ? 'Active' : 'Inactive'}</span></td>
          <td><div class="admin-row-actions">
            <button class="admin-btn admin-btn-sm admin-btn-ghost prod-edit" data-id="${p.id}">Edit</button>
            <button class="admin-btn admin-btn-sm ${p.is_active ? 'admin-btn-danger' : ''}" data-id="${p.id}" data-active="${p.is_active}" data-toggle-active>${p.is_active ? 'Deactivate' : 'Activate'}</button>
          </div></td>
        </tr>`).join('') +
      '</tbody></table></div>';

    wrap.querySelectorAll('[data-toggle-active]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const nextActive = btn.dataset.active !== 'true';
        const { error: err } = await sb.from('products').update({ is_active: nextActive }).eq('id', id);
        if (err) { toast('Could not update product: ' + err.message, true); return; }
        toast(nextActive ? 'Product reactivated.' : 'Product deactivated — hidden from the public site, existing orders are untouched.');
        loadProducts();
      });
    });

    wrap.querySelectorAll('.prod-edit').forEach((btn) => {
      btn.addEventListener('click', () => openProductEditor(btn.dataset.id));
    });
  }

  function newSpecsRow(key, value) {
    const row = document.createElement('div');
    row.className = 'admin-form-row spec-row';
    row.innerHTML =
      '<div class="admin-field"><label>Spec Label</label><input class="spec-key" value="' + esc(key || '') + '" placeholder="Material"></div>' +
      '<div class="admin-field"><label>Spec Value</label><input class="spec-val" value="' + esc(value || '') + '" placeholder="18k yellow gold"></div>';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'admin-btn admin-btn-sm admin-btn-danger';
    removeBtn.textContent = 'Remove';
    removeBtn.style.marginBottom = '18px';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(removeBtn);
    return row;
  }

  function readSpecsFromForm(container) {
    const specs = {};
    container.querySelectorAll('.spec-row').forEach((row) => {
      const k = row.querySelector('.spec-key').value.trim();
      const v = row.querySelector('.spec-val').value.trim();
      if (k) specs[k] = v;
    });
    return specs;
  }

  async function openProductEditor(productId) {
    document.getElementById('productEditorWrap').scrollIntoView({ behavior: 'smooth' });
    const isNew = !productId;

    let product = {
      slug: '', reference_sku: '', name: '', material: '', description: '',
      specs: {}, price_cents: null, quantity_total: 1, is_active: true, category_id: categories[0] ? categories[0].id : null,
    };
    let images = [];

    if (!isNew) {
      const [{ data: p, error: pErr }, { data: imgs, error: iErr }] = await Promise.all([
        sb.from('products').select('*').eq('id', productId).single(),
        sb.from('product_images').select('*').eq('product_id', productId).order('sort_order'),
      ]);
      if (pErr) { toast('Could not load product: ' + pErr.message, true); return; }
      product = p;
      images = imgs || [];
    }

    const wrap = document.getElementById('productEditorWrap');
    wrap.innerHTML = `
      <div class="admin-card">
        <h3>${isNew ? 'Add Product' : 'Edit — ' + esc(product.name)}</h3>
        <div class="admin-form-row">
          <div class="admin-field"><label>Name</label><input id="pf-name" value="${esc(product.name)}"></div>
          <div class="admin-field"><label>Slug (URL-safe, unique)</label><input id="pf-slug" value="${esc(product.slug)}" ${isNew ? '' : 'title="Changing this breaks any bookmarked/shared product links"'}></div>
          <div class="admin-field"><label>Reference SKU (unique)</label><input id="pf-sku" value="${esc(product.reference_sku)}"></div>
          <div class="admin-field"><label>Category</label><select id="pf-category" class="category-select"></select></div>
          <div class="admin-field"><label>Price (HK$, blank = Contact for Price)</label><input id="pf-price" type="number" step="0.01" min="0" value="${product.price_cents != null ? centsToDollars(product.price_cents) : ''}"></div>
          <div class="admin-field"><label>Stock (total ever stocked, usually 1)</label><input id="pf-qty" type="number" min="0" value="${esc(product.quantity_total)}"></div>
          <div class="admin-field"><label>Material (short summary line)</label><input id="pf-material" value="${esc(product.material || '')}"></div>
          <div class="admin-field"><label class="admin-toggle" style="margin-top:30px;"><input type="checkbox" id="pf-active" ${product.is_active ? 'checked' : ''}> Active (visible on the public site)</label></div>
          <div class="admin-field full"><label>Description</label><textarea id="pf-desc">${esc(product.description || '')}</textarea></div>
        </div>

        <div class="admin-section-title">Specifications</div>
        <div id="specsRows"></div>
        <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost" id="addSpecRow">+ Add Spec Row</button>

        ${isNew ? '' : `
        <div class="admin-section-title">Photos</div>
        <div class="admin-image-grid" id="imageGrid"></div>
        <div class="admin-form-row">
          <div class="admin-field"><label>Image URL</label><input id="newImageUrl" placeholder="https://…"></div>
          <div class="admin-field"><label>Or Upload a File</label><input id="newImageFile" type="file" accept="image/*"></div>
        </div>
        <button type="button" class="admin-btn admin-btn-sm admin-btn-ghost" id="addImageBtn">Add Photo</button>
        `}

        <div class="admin-form-actions">
          <button class="admin-btn" id="pf-save">${isNew ? 'Create Product' : 'Save Changes'}</button>
          <button class="admin-btn admin-btn-ghost" id="pf-cancel">Cancel</button>
        </div>
      </div>
    `;

    populateCategorySelects();
    document.getElementById('pf-category').value = product.category_id || '';

    const specsRows = document.getElementById('specsRows');
    const specEntries = Object.entries(product.specs || {});
    if (specEntries.length === 0) specsRows.appendChild(newSpecsRow());
    specEntries.forEach(([k, v]) => specsRows.appendChild(newSpecsRow(k, v)));
    document.getElementById('addSpecRow').addEventListener('click', () => specsRows.appendChild(newSpecsRow()));

    if (!isNew) {
      renderImageGrid(images, productId);
      document.getElementById('addImageBtn').addEventListener('click', () => addProductImage(productId, images));
    }

    document.getElementById('pf-cancel').addEventListener('click', () => { wrap.innerHTML = ''; });

    document.getElementById('pf-save').addEventListener('click', async () => {
      const priceRaw = document.getElementById('pf-price').value.trim();
      const fields = {
        name: document.getElementById('pf-name').value.trim(),
        slug: document.getElementById('pf-slug').value.trim(),
        reference_sku: document.getElementById('pf-sku').value.trim(),
        category_id: document.getElementById('pf-category').value,
        price_cents: priceRaw === '' ? null : dollarsToCents(priceRaw),
        quantity_total: parseInt(document.getElementById('pf-qty').value, 10) || 1,
        material: document.getElementById('pf-material').value.trim(),
        is_active: document.getElementById('pf-active').checked,
        description: document.getElementById('pf-desc').value.trim(),
        specs: readSpecsFromForm(specsRows),
      };

      if (!fields.name || !fields.slug || !fields.reference_sku || !fields.category_id) {
        toast('Name, slug, SKU, and category are required.', true);
        return;
      }

      const saveBtn = document.getElementById('pf-save');
      saveBtn.disabled = true;

      const { error } = isNew
        ? await sb.from('products').insert(fields)
        : await sb.from('products').update(fields).eq('id', productId);

      saveBtn.disabled = false;

      if (error) {
        toast('Save failed: ' + (error.message.includes('duplicate') ? 'that slug or SKU is already in use.' : error.message), true);
        return;
      }

      toast(isNew ? 'Product created.' : 'Product saved.');
      wrap.innerHTML = '';
      loadProducts();
    });
  }

  function renderImageGrid(images, productId) {
    const grid = document.getElementById('imageGrid');
    if (!grid) return;
    if (images.length === 0) { grid.innerHTML = '<div class="admin-empty">No photos yet.</div>'; return; }

    grid.innerHTML = images.map((img) => `
      <div class="admin-image-tile" data-img-id="${img.id}">
        <img src="${esc(img.url)}" alt="">
        ${img.is_primary ? '<span class="primary-flag">Primary</span>' : ''}
        <div class="tile-actions">
          ${img.is_primary ? '' : '<button data-set-primary>Set Primary</button>'}
          <button data-delete-image>Delete</button>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('[data-set-primary]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.admin-image-tile').dataset.imgId;
        const { error } = await sb.from('product_images').update({ is_primary: true }).eq('id', id);
        if (error) { toast('Could not set primary: ' + error.message, true); return; }
        const { data: imgs } = await sb.from('product_images').select('*').eq('product_id', productId).order('sort_order');
        renderImageGrid(imgs || [], productId);
      });
    });

    grid.querySelectorAll('[data-delete-image]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.admin-image-tile').dataset.imgId;
        if (!confirm('Delete this photo?')) return;
        const { error } = await sb.from('product_images').delete().eq('id', id);
        if (error) { toast('Could not delete: ' + error.message, true); return; }
        const { data: imgs } = await sb.from('product_images').select('*').eq('product_id', productId).order('sort_order');
        renderImageGrid(imgs || [], productId);
      });
    });
  }

  async function addProductImage(productId, currentImages) {
    const urlInput = document.getElementById('newImageUrl');
    const fileInput = document.getElementById('newImageFile');
    let url = urlInput.value.trim();

    if (!url && fileInput.files[0]) {
      const file = fileInput.files[0];
      const path = `${productId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: upErr } = await sb.storage.from('product-images').upload(path, file);
      if (upErr) { toast('Upload failed: ' + upErr.message, true); return; }
      const { data: pub } = sb.storage.from('product-images').getPublicUrl(path);
      url = pub.publicUrl;
    }

    if (!url) { toast('Provide an image URL or choose a file to upload.', true); return; }

    const nextSort = (currentImages && currentImages.length) || 0;
    const { error } = await sb.from('product_images').insert({
      product_id: productId,
      url,
      sort_order: nextSort,
      is_primary: nextSort === 0,
    });
    if (error) { toast('Could not add photo: ' + error.message, true); return; }

    urlInput.value = '';
    fileInput.value = '';
    const { data: imgs } = await sb.from('product_images').select('*').eq('product_id', productId).order('sort_order');
    renderImageGrid(imgs || [], productId);
    toast('Photo added.');
  }

  // ---------------------------------------------------------------------
  // orders
  // ---------------------------------------------------------------------
  const FULFILLMENT_STATUSES = ['pending', 'processing', 'ready_for_collection', 'shipped', 'delivered', 'cancelled'];

  async function loadOrders() {
    const wrap = document.getElementById('ordersTableWrap');
    wrap.innerHTML = '<div class="admin-loading">Loading orders…</div>';

    const paymentFilter = document.getElementById('filterPaymentStatus').value;
    const fulfillmentFilter = document.getElementById('filterFulfillmentStatus').value;

    let query = sb.from('orders').select('*').order('created_at', { ascending: false }).limit(300);
    if (paymentFilter) query = query.eq('payment_status', paymentFilter);
    if (fulfillmentFilter) query = query.eq('fulfillment_status', fulfillmentFilter);

    const { data, error } = await query;
    if (error) { wrap.innerHTML = '<div class="admin-empty">Could not load orders: ' + esc(error.message) + '</div>'; return; }
    currentOrders = data || [];

    if (currentOrders.length === 0) { wrap.innerHTML = '<div class="admin-empty">No orders match these filters.</div>'; return; }

    wrap.innerHTML =
      '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>' +
      '<th>Order</th><th>Customer</th><th>Total</th><th>Payment</th><th>Fulfillment</th><th>Placed</th><th></th>' +
      '</tr></thead><tbody>' +
      currentOrders.map((o) => `
        <tr>
          <td class="admin-mono">${esc(o.order_number)}</td>
          <td>${esc(o.guest_name || '—')}<br><span class="admin-mono">${esc(o.guest_email || '')}</span></td>
          <td>${esc(fmt(o.total_cents))}</td>
          <td><span class="admin-badge badge-${esc(o.payment_status)}">${esc(o.payment_status.replace(/_/g, ' '))}</span></td>
          <td><span class="admin-badge badge-${esc(o.fulfillment_status)}">${esc(o.fulfillment_status.replace(/_/g, ' '))}</span></td>
          <td>${new Date(o.created_at).toLocaleDateString()}</td>
          <td><button class="admin-btn admin-btn-sm admin-btn-ghost order-expand" data-id="${o.id}">Details</button></td>
        </tr>
        <tr class="admin-order-detail" id="order-detail-${o.id}"><td colspan="7"></td></tr>
      `).join('') +
      '</tbody></table></div>';

    wrap.querySelectorAll('.order-expand').forEach((btn) => {
      btn.addEventListener('click', () => toggleOrderDetail(btn.dataset.id));
    });
  }

  async function toggleOrderDetail(orderId) {
    const row = document.getElementById('order-detail-' + orderId);
    const isOpen = row.classList.contains('open');
    document.querySelectorAll('.admin-order-detail.open').forEach((r) => r.classList.remove('open'));
    if (isOpen) return;

    row.querySelector('td').innerHTML = '<div class="admin-loading">Loading order…</div>';
    row.classList.add('open');

    const order = currentOrders.find((o) => o.id === orderId);
    const [{ data: items }, { data: payments }] = await Promise.all([
      sb.from('order_items').select('*').eq('order_id', orderId),
      sb.from('payments').select('*').eq('order_id', orderId).order('created_at', { ascending: false }),
    ]);

    const addr = order.delivery_address || {};
    const addrText = addr.notes || Object.values(addr).filter(Boolean).join(', ') || '—';

    row.querySelector('td').innerHTML = `
      <div class="admin-order-detail-inner">
        <div class="admin-kv">
          <div class="k">Phone</div><div class="v">${esc(order.guest_phone || '—')}</div>
          <div class="k">Delivery / Appt.</div><div class="v">${esc(addrText)}</div>
          <div class="k">Payment Method</div><div class="v">${esc((order.payment_method || '—').replace(/_/g, ' '))}</div>
          <div class="k">Notes</div><div class="v">${esc(order.notes || '—')}</div>
        </div>

        <div class="admin-section-title">Items</div>
        <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Unit</th><th>Line Total</th></tr></thead><tbody>
          ${(items || []).map((it) => `<tr><td>${esc(it.name_snapshot)}</td><td class="admin-mono">${esc(it.reference_sku_snapshot)}</td><td>${esc(it.quantity)}</td><td>${esc(fmt(it.unit_price_cents))}</td><td>${esc(fmt(it.line_total_cents))}</td></tr>`).join('') || '<tr><td colspan="5">No items found.</td></tr>'}
        </tbody></table></div>

        <div class="admin-section-title">Payments</div>
        <div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Provider</th><th>Status</th><th>Amount</th><th>Capture / Ref</th><th></th></tr></thead><tbody>
          ${(payments || []).map((p) => `<tr><td>${esc(p.provider)}</td><td>${esc(p.status)}</td><td>${esc(fmt(p.amount_cents))}</td><td class="admin-mono">${esc(p.provider_capture_id || p.provider_order_id || '—')}</td>
            <td>${p.status === 'captured' ? `<button class="admin-btn admin-btn-sm admin-btn-danger refund-btn" data-payment-id="${p.id}" data-max="${p.amount_cents}">Record Refund</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No payment recorded yet.</td></tr>'}
        </tbody></table></div>

        <div class="admin-section-title">Actions</div>
        <div class="admin-form-row thirds">
          <div class="admin-field">
            <label>Fulfillment Status</label>
            <select class="admin-select-sm fulfillment-select">
              ${FULFILLMENT_STATUSES.map((s) => `<option value="${s}" ${s === order.fulfillment_status ? 'selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}
            </select>
          </div>
          <div class="admin-field"><button class="admin-btn admin-btn-sm save-fulfillment">Update Fulfillment</button></div>
          ${(order.payment_status === 'pending' && order.payment_method && order.payment_method !== 'paypal') ? `
          <div class="admin-field"><button class="admin-btn admin-btn-sm mark-paid-btn">Mark as Paid…</button></div>` : ''}
        </div>
      </div>
    `;

    row.querySelector('.save-fulfillment').addEventListener('click', async () => {
      const status = row.querySelector('.fulfillment-select').value;
      const { error } = await sb.from('orders').update({ fulfillment_status: status }).eq('id', orderId);
      if (error) { toast('Could not update: ' + error.message, true); return; }
      toast('Fulfillment status updated.');
      loadOrders();
    });

    const markPaidBtn = row.querySelector('.mark-paid-btn');
    if (markPaidBtn) {
      markPaidBtn.addEventListener('click', async () => {
        const amountStr = prompt('Amount received, in HK$ (defaults to the order total):', centsToDollars(order.total_cents));
        if (amountStr === null) return;
        const reference = prompt('Reference (bank transfer reference, invoice number, etc.) — optional:', '') || null;
        const { error } = await sb.rpc('admin_mark_order_paid', {
          p_order_id: orderId,
          p_amount_cents: dollarsToCents(amountStr),
          p_reference: reference,
        });
        if (error) { toast('Could not mark paid: ' + error.message, true); return; }
        toast('Order marked as paid.');
        loadOrders();
      });
    }

    row.querySelectorAll('.refund-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const maxCents = parseInt(btn.dataset.max, 10);
        const amountStr = prompt('Refund amount, in HK$ (captured amount was ' + fmt(maxCents) + '):', centsToDollars(maxCents));
        if (amountStr === null) return;
        const reason = prompt('Reason for refund (shown internally only):', '') || null;
        const { error } = await sb.rpc('admin_record_refund', {
          p_payment_id: btn.dataset.paymentId,
          p_amount_cents: dollarsToCents(amountStr),
          p_reason: reason,
          p_provider_refund_id: null,
        });
        if (error) { toast('Could not record refund: ' + error.message, true); return; }
        toast('Refund recorded. Remember: this does not move money at PayPal — issue the actual refund from the PayPal dashboard too.');
        toggleOrderDetail(orderId);
        toggleOrderDetail(orderId);
        loadOrders();
      });
    });
  }

  // ---------------------------------------------------------------------
  // enquiries
  // ---------------------------------------------------------------------
  async function loadEnquiries() {
    const wrap = document.getElementById('enquiriesTableWrap');
    wrap.innerHTML = '<div class="admin-loading">Loading enquiries…</div>';

    const { data, error } = await sb.from('enquiries').select('*').order('created_at', { ascending: false }).limit(300);
    if (error) { wrap.innerHTML = '<div class="admin-empty">Could not load enquiries: ' + esc(error.message) + '</div>'; return; }
    if (!data || data.length === 0) { wrap.innerHTML = '<div class="admin-empty">No enquiries yet.</div>'; return; }

    wrap.innerHTML =
      '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>' +
      '<th>Contact</th><th>Channel</th><th>Message</th><th>Received</th><th>Status</th>' +
      '</tr></thead><tbody>' +
      data.map((e) => `
        <tr data-eq-id="${e.id}">
          <td>${esc(e.name || '—')}<br><span class="admin-mono">${esc(e.email || e.phone || '')}</span></td>
          <td>${esc(e.channel || '—')}</td>
          <td style="max-width:260px;">${esc(e.message || '—')}</td>
          <td>${new Date(e.created_at).toLocaleDateString()}</td>
          <td><select class="admin-select-sm eq-status">
            ${['new', 'contacted', 'closed'].map((s) => `<option value="${s}" ${s === e.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select></td>
        </tr>`).join('') +
      '</tbody></table></div>';

    wrap.querySelectorAll('.eq-status').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.closest('tr').dataset.eqId;
        const { error: err } = await sb.from('enquiries').update({ status: sel.value }).eq('id', id);
        if (err) { toast('Could not update: ' + err.message, true); return; }
        toast('Enquiry updated.');
      });
    });
  }

  // ---------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('loginForm').addEventListener('submit', (e) => {
      e.preventDefault();
      attemptLogin(document.getElementById('loginEmail').value.trim(), document.getElementById('loginPassword').value);
    });

    document.getElementById('signOutBtn').addEventListener('click', signOut);

    document.querySelectorAll('.admin-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('addProductBtn').addEventListener('click', () => openProductEditor(null));
    document.getElementById('applyOrderFilters').addEventListener('click', loadOrders);

    const { data: { session } } = await sb.auth.getSession();
    if (session) await enterAdmin();
    else showLogin();

    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') showLogin();
    });
  });
})();
