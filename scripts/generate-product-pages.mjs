#!/usr/bin/env node
/**
 * Jade You — static product page generator.
 *
 * Run manually, once, any time a product is inserted or edited:
 *
 *   npm install @supabase/supabase-js
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=your-secret-key \
 *   node generate-product-pages.mjs
 *
 * Uses the SECRET key, not the publishable key — this runs on your machine
 * (or in CI), never in a browser, so it's fine for it to bypass RLS the
 * same way the edge functions do. Never put the service_role key in
 * config.js or any file that ships to the browser.
 *
 * Behaviour: rewrites EVERY active product's page on every run (cheap at
 * this catalog size — no point tracking "only what changed"). After
 * writing each file it stamps products.page_generated_at = now(), so you
 * can always answer "is this page current?" with one query against the
 * database instead of a separate manifest file — see migration 006.
 */

import { createClient } from '@supabase/supabase-js';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as environment variables before running.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Resolve relative to this script's own location, not the current working
// directory — so `node scripts/generate-product-pages.mjs` from the repo
// root and `node generate-product-pages.mjs` from inside scripts/ both
// land in the same place. Assumes the layout scripts/<this file> with
// product/ as a sibling of scripts/ at the repo root; adjust the '..' if
// you place the script somewhere else.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(__dirname, '..', 'product');

// ----------------------------------------------------------------------------
// Category display metadata (icon path + card colour) isn't modeled in the
// database yet — categories are few and effectively fixed, so a lookup
// table here is simpler than a schema change. If a 7th category ever gets
// added, add one line here.
// ----------------------------------------------------------------------------
const CATEGORY_META = {
  'rings':              { icon: '<circle cx="24" cy="30" r="12"/><path d="M18 19 L24 6 L30 19"/>', tone: 'tone-violet' },
  'bangles-bracelets':  { icon: '<circle cx="24" cy="24" r="17"/><circle cx="24" cy="24" r="10"/>', tone: 'tone-jade' },
  'earrings':           { icon: '<circle cx="24" cy="16" r="6"/><path d="M24 22 L24 40"/>', tone: 'tone-jade' },
  'necklaces-pendants': { icon: '<path d="M10 10 Q24 6 38 10"/><circle cx="24" cy="28" r="9"/>', tone: 'tone-violet' },
  'bridal':             { icon: '<circle cx="18" cy="24" r="9"/><circle cx="30" cy="24" r="9"/>', tone: 'tone-violet' },
  'mens':                { icon: '<rect x="12" y="16" width="24" height="16" rx="2"/><path d="M18 16 V10 H30 V16"/>', tone: 'tone-jade' },
};

// jsonb does NOT guarantee key order survives a round trip through
// Postgres (unlike the `json` type). Sort spec rows explicitly rather
// than trust whatever order Object.entries(specs) happens to return.
// Anything not listed here is appended afterward, alphabetically.
const SPEC_ORDER = [
  'Material', 'Jadeite', 'Colour', 'Transparency', 'Translucency',
  'Dimensions', 'Bead Size', 'Diamonds', 'Chain Length', 'Inner Diameter',
  'Total Weight',
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function fmtPrice(cents) {
  return 'US$' + (cents / 100).toLocaleString('en-US');
}

function sortSpecs(specs) {
  return Object.entries(specs || {}).sort(([a], [b]) => {
    const ia = SPEC_ORDER.indexOf(a), ib = SPEC_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

// The public spec table only ever shows lab name, cert number, material
// conclusion, and a request line — instrument-level detail stays in
// test_details, off the page, by design (see product_certifications).
function certRows(certs) {
  return (certs || []).map((c) => {
    const bits = [
      c.material_description,
      `${c.laboratory_name}, Report ${c.certificate_number}`,
      c.verification_url ? `verify at ${c.verification_url.replace(/^https?:\/\//, '')}` : null,
      'Certificate available on request.',
    ].filter(Boolean);
    return `<tr><td>Certification</td><td>${esc(bits.join(' — '))}</td></tr>`;
  }).join('\n        ');
}

function enquiryRow(name, ref) {
  const wa = `https://wa.me/85236110360?text=${encodeURIComponent(`I'd like to enquire about the ${name} (${ref})`)}`;
  const subject = encodeURIComponent(`Enquiry — ${name} (${ref})`);
  const body = encodeURIComponent(`Hello Jade You,\n\nI would like to enquire about the ${name} (${ref}).\n\nPlease let me know availability and price.`);
  return `<a class="enquiry-btn primary" href="tel:+85236110360"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M6 3h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 12l5 2v4a2 2 0 0 1-2 2C10.5 20 4 13.5 4 5a2 2 0 0 1 2-2z"/></svg>Call Jade You</a>
        <a class="enquiry-btn" target="_blank" rel="noopener" href="${wa}"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 20l1.1-5.4A8.5 8.5 0 1 1 21 11.5z"/></svg>WhatsApp Enquiry</a>
        <a class="enquiry-btn" href="mailto:hello@jadeyou.com?subject=${subject}&body=${body}"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>Email Enquiry</a>
        <a class="enquiry-btn js-wechat" href="#"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8 10h.01M12 10h.01M16 10h.01"/></svg>WeChat Enquiry</a>`;
}

function relatedCard(p) {
  const meta = CATEGORY_META[p.categories.slug] || CATEGORY_META.rings;
  const priceLine = p.price_cents == null
    ? '<p class="p-contact-note">Contact for Price</p>'
    : `<p class="p-price">${fmtPrice(p.price_cents)}</p>`;
  return `<a class="product-card" href="../product/${p.slug}.html">
        <div class="p-image ${meta.tone}"><svg viewBox="0 0 48 48" fill="none" stroke-width="1.3">${meta.icon}</svg></div>
        <div class="p-ref">${esc(p.reference_sku)}</div>
        <h3>${esc(p.name)}</h3>
        <p class="p-material">${esc(p.material || '')}</p>
        ${priceLine}
        <span class="p-link">View Details &rarr;</span>
      </a>`;
}

function renderPage(product, category, images, certs, related) {
  const meta = CATEGORY_META[category.slug] || CATEGORY_META.rings;
  const name = product.name, ref = product.reference_sku;

  const heroContent = images[0]
    ? `<img src="${esc(images[0].url)}" alt="${esc(images[0].alt_text || name)}" style="width:100%;height:100%;object-fit:cover;">`
    : `<svg viewBox="0 0 48 48" fill="none" stroke-width="1.1">${meta.icon}</svg>`;

  const specRows = sortSpecs(product.specs).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('\n        ');
  const allSpecRows = [specRows, certRows(certs)].filter(Boolean).join('\n        ');

  const priceSection = product.price_cents == null
    ? `<div class="price-note">Contact us for the price</div>
        <div class="enquiry-row">
        ${enquiryRow(name, ref)}
      </div>`
    : `<div class="product-price">${fmtPrice(product.price_cents)}</div>
        <div class="reserve-row">
          <div class="qty-stepper">
            <button type="button" id="reserveQtyDec" aria-label="Decrease quantity">&minus;</button>
            <span><input id="reserveQty" value="1" style="width:24px;border:none;background:none;text-align:center;font-family:inherit;font-size:inherit;" readonly></span>
            <button type="button" id="reserveQtyInc" aria-label="Increase quantity">&plus;</button>
          </div>
          <button class="btn btn-solid" id="addToCartBtn" data-item='${JSON.stringify({ slug: product.slug, name, ref, price: product.price_cents / 100, tone: meta.tone, icon: meta.icon })}'>Add to Reservation</button>
        </div>
        <div class="secondary-contact">
          <div class="sc-label">Prefer to ask first?</div>
          <div class="enquiry-row">
        ${enquiryRow(name, ref)}
      </div>
        </div>`;

  const relatedHTML = related.map(relatedCard).join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(name)} — Jade You</title>
<meta name="description" content="${esc(name)}: ${esc(product.material || '')}${product.price_cents != null ? '. ' + fmtPrice(product.price_cents) + '.' : '.'}">
<link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon-32.png">
<link rel="apple-touch-icon" href="../assets/apple-touch-icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,900;1,500;1,600&family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Jost:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../styles.css">
<script>window.SITE_PREFIX = "../";</script>
</head>
<body>
<header class="site-header" id="siteHeader">
  <a href="../index.html" class="brand">
    <img src="../assets/logo-mark-128.png" alt="">
    <span>JADE&nbsp;YOU</span>
  </a>
  <nav class="nav-links" id="navLinks">
    <a href="../index.html#collections">Collections</a>
    <a href="../index.html#provenance">Provenance</a>
    <a href="../index.html#journal">Jade Journal</a>
    <a href="../index.html#atelier">Atelier</a>
    <a href="../index.html#atelier" class="nav-cta">Request Appointment</a>
  </nav>
  <button class="cart-toggle" aria-label="Open reservation cart">
    <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6"><path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>
    <span class="cart-badge hidden">0</span>
  </button>
  <button class="nav-toggle" id="navToggle" aria-label="Toggle menu">
    <span></span><span></span><span></span>
  </button>
</header>

<section class="breadcrumb-band">
  <div class="wrap">
    <div class="breadcrumb"><a href="../index.html">Home</a> <span class="sep">/</span> <a href="../collections/${category.slug}.html">${esc(category.name)}</a> <span class="sep">/</span> <span class="current">${esc(name)}</span></div>
  </div>
</section>

<section class="product-detail">
  <div class="wrap">
    <div class="product-detail-grid">
      <div class="product-hero-image ${meta.tone}">
        ${heroContent}
      </div>
      <div class="product-info">
        <div class="product-ref">Reference ${esc(ref)}</div>
        <h1>${esc(name)}</h1>
        ${priceSection}
        <p class="product-desc">${esc(product.description || '')}</p>
        <table class="spec-table">
        ${allSpecRows}
        </table>
      </div>
    </div>
  </div>
</section>

<section class="related">
  <div class="wrap">
    <div class="section-head">
      <div class="eyebrow">You May Also Like</div>
      <h2>From the ${esc(category.name)} Collection</h2>
    </div>
    <div class="product-grid">
      ${relatedHTML}
    </div>
  </div>
</section>
<footer>
  <div class="wrap">
    <div class="footer-top">
      <a href="../index.html" class="footer-brand">
        <img src="../assets/logo-mark-128.png" alt="">
        <span>JADE&nbsp;YOU</span>
      </a>
      <div class="footer-links">
        <div class="footer-col">
          <h4>Explore</h4>
          <a href="../index.html#collections">Collections</a>
          <a href="../index.html#provenance">Provenance</a>
          <a href="../index.html#journal">Jade Journal</a>
        </div>
        <div class="footer-col">
          <h4>House</h4>
          <a href="../index.html#atelier">Atelier</a>
          <a href="../index.html#atelier">Request Appointment</a>
          <a href="../index.html#atelier">Bespoke Commissions</a>
        </div>
        <div class="footer-col">
          <h4>Contact</h4>
          <a href="mailto:hello@jadeyou.com">hello@jadeyou.com</a>
          <a href="../index.html#atelier">Central, Hong Kong</a>
        </div>
      </div>
    </div>
    <div class="footer-bottom">
      <span>&copy; 2026 Jade You. All rights reserved.</span>
      <div class="footer-social">
        <a href="#" aria-label="Instagram"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/></svg></a>
        <a href="#" aria-label="WeChat"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/></svg></a>
      </div>
    </div>
  </div>
</footer>

<div class="wechat-pop" id="wechatPop">
  <div class="wechat-card">
    <button class="wechat-close" id="wechatClose" aria-label="Close">&times;</button>
    <img src="../assets/wechat-qr.png" alt="Jade You WeChat QR code">
    <h4>Add Jade You on WeChat</h4>
    <p>Scan to chat with our Atelier team directly, or search ID: JadeYouHK</p>
  </div>
</div>

<div class="cart-overlay" id="cartOverlay"></div>
<div class="cart-drawer" id="cartDrawer">
  <div class="cart-drawer-head">
    <h3>Your Reservations <span class="eyebrow">(held for 48 hours)</span></h3>
    <button class="cart-drawer-close" id="cartDrawerClose" aria-label="Close">&times;</button>
  </div>
  <div class="cart-items" id="cartItems"></div>
  <div class="cart-drawer-foot" id="cartDrawerFoot" style="display:none;">
    <div class="cart-subtotal"><span>Subtotal</span><span class="amt" id="cartSubtotal">US$0</span></div>
    <div class="cart-note">Shipping and final total confirmed by your Atelier advisor.</div>
    <a href="../checkout.html" class="btn btn-solid">Proceed to Checkout</a>
  </div>
</div>

<script src="../main.js"></script>
<script src="../cart.js"></script>
<script>
  (function(){
    var pop = document.getElementById('wechatPop');
    var close = document.getElementById('wechatClose');
    document.querySelectorAll('.js-wechat').forEach(function(btn){
      btn.addEventListener('click', function(e){ e.preventDefault(); pop.classList.add('open'); });
    });
    if(close) close.addEventListener('click', function(){ pop.classList.remove('open'); });
    if(pop) pop.addEventListener('click', function(e){ if(e.target===pop) pop.classList.remove('open'); });
  })();
</script>
</body>
</html>
`;
}

// Not a cleanup step — deliberately never deletes anything automatically.
// Flags any file in product/ that doesn't match a currently-active
// product's slug, which happens when a slug gets renamed (old file left
// behind) or a product gets deactivated (its page stays live on GitHub
// Pages even though the catalog no longer lists it). Surfacing it is
// enough; removing it is a decision a human should make.
async function checkOrphans(currentSlugs) {
  let files;
  try {
    files = await readdir(OUTPUT_DIR);
  } catch {
    return;
  }
  const orphans = files.filter((f) => f.endsWith('.html') && !currentSlugs.has(f.replace(/\.html$/, '')));
  if (orphans.length > 0) {
    console.log(`\n⚠ ${orphans.length} file(s) in ${OUTPUT_DIR}/ don't match any active product — from a renamed slug or a deactivated product. Not deleted automatically:`);
    orphans.forEach((f) => console.log(`   - ${f}`));
  }
}

async function fetchRelated(categoryId, excludeId) {
  const { data } = await supabase
    .from('products')
    .select('slug, name, material, price_cents, reference_sku, categories(slug)')
    .eq('category_id', categoryId)
    .eq('is_active', true)
    .neq('id', excludeId)
    .limit(3);
  return data || [];
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const { data: products, error } = await supabase
    .from('products')
    .select(`
      id, slug, reference_sku, name, material, description, specs, price_cents, category_id,
      categories ( slug, name ),
      product_images ( url, alt_text, is_primary, sort_order ),
      product_certifications ( laboratory_name, certificate_number, material_description, verification_url )
    `)
    .eq('is_active', true);

  if (error) {
    console.error('Failed to fetch products:', error.message);
    process.exit(1);
  }
  if (!products || products.length === 0) {
    console.log('No active products found — nothing to build.');
    return;
  }

  for (const p of products) {
    const images = (p.product_images || []).sort((a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order));
    const related = await fetchRelated(p.category_id, p.id);
    const html = renderPage(p, p.categories, images, p.product_certifications, related);

    await writeFile(path.join(OUTPUT_DIR, `${p.slug}.html`), html, 'utf8');
    await supabase.from('products').update({ page_generated_at: new Date().toISOString() }).eq('id', p.id);

    console.log(`✓ ${p.reference_sku}  →  product/${p.slug}.html`);
  }

  console.log(`\nDone — ${products.length} page(s) written to ${OUTPUT_DIR}/`);
  await checkOrphans(new Set(products.map((p) => p.slug)));
}

main();
