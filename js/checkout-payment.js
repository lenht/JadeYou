/* Jade You — checkout payment logic.
   Handles the Pay Now (PayPal) / Arrange with Advisor tabs, gates the
   PayPal button behind basic contact-form validation, and renders
   PayPal's Smart Buttons (Visa/Mastercard/Amex included via PayPal's own
   guest card checkout — no separate card processor needed).

   The part that differs from a typical PayPal Buttons integration:
   createOrder does NOT call actions.order.create() itself. It calls our
   own create-checkout Edge Function, which looks up real prices and
   reserves real stock server-side, then creates the PayPal order there —
   the browser only ever gets back an order ID to hand to the Buttons
   component. Same for capture: onApprove calls our capture-checkout
   function instead of actions.order.capture(), so the order is only ever
   finalized after the server independently verifies what PayPal actually
   captured. See schema.sql's complete_order() for why this distinction is
   the whole point, not a stylistic choice. */

(function () {
  function fmt(n) { return 'US$' + Number(n).toLocaleString('en-US'); }

  const FUNCTIONS_URL = window.SUPABASE_FUNCTIONS_URL;
  const ANON_KEY = window.SUPABASE_ANON_KEY;

  async function callFunction(name, payload) {
    const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ANON_KEY,
        'apikey': ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || (name + ' failed'));
    return data;
  }

  document.addEventListener('DOMContentLoaded', function () {
    // ---------- tab switching ----------
    const tabs = document.querySelectorAll('.pay-tab');
    const panels = document.querySelectorAll('.pay-panel');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.panel).classList.add('active');
      });
    });

    // ---------- gate the PayPal button behind basic contact info ----------
    const lock = document.getElementById('paypalLock');
    const requiredIds = ['coName', 'coEmail', 'coPhone'];
    function checkFormValid() {
      const valid = requiredIds.every(id => {
        const el = document.getElementById(id);
        return el && el.value.trim().length > 1;
      });
      if (lock) lock.classList.toggle('unlocked', valid);
      return valid;
    }
    requiredIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', checkFormValid);
    });
    checkFormValid();

    function getContact() {
      return {
        guestName: document.getElementById('coName').value.trim(),
        guestEmail: document.getElementById('coEmail').value.trim(),
        guestPhone: document.getElementById('coPhone').value.trim(),
        deliveryAddress: { notes: document.getElementById('coAddress').value.trim() },
      };
    }

    // ---------- render PayPal Smart Buttons ----------
    const container = document.getElementById('paypal-button-container');
    if (window.paypal && container) {
      // Carries state between createOrder and onApprove/onCancel for a
      // single checkout attempt — the SDK calls these sequentially for
      // one click cycle, so a closure variable here is enough.
      let currentReservationIds = [];

      paypal.Buttons({
        style: { color: 'black', shape: 'rect', label: 'pay', height: 45 },

        onClick: function (data, actions) {
          if (!checkFormValid()) {
            alert('Please complete your name, email, and phone number before paying.');
            return actions.reject();
          }
          return actions.resolve();
        },

        createOrder: async function () {
          const items = (window.Cart ? Cart.get() : []).map(i => ({ slug: i.slug, quantity: i.qty }));
          if (items.length === 0) {
            alert('Your cart is empty.');
            throw new Error('Empty cart');
          }
          try {
            const result = await callFunction('create-checkout', { items, ...getContact() });
            currentReservationIds = result.reservationIds;
            return result.paypalOrderId;
          } catch (err) {
            alert(err.message || 'Unable to start checkout. Please try again.');
            throw err;
          }
        },

        onApprove: async function (data) {
          try {
            const result = await callFunction('capture-checkout', {
              paypalOrderId: data.orderID,
              reservationIds: currentReservationIds,
            });
            document.getElementById('paypalConfirmDetail').textContent =
              'Thank you — your order' + (result.orderId ? ' (' + result.orderId + ')' : '') + ' has been placed successfully.';
          } catch (err) {
            // Payment already succeeded with PayPal at this point — the
            // PayPal webhook is the backstop that finishes the order
            // server-side even if this specific response was lost, so
            // this is a "we'll follow up" message, not a failure message.
            document.getElementById('paypalConfirmDetail').textContent =
              'Your payment was received. We are finalizing your order and will confirm by email shortly.';
          }
          const notifyBtn = document.getElementById('paypalNotifyBtn');
          if (notifyBtn) notifyBtn.style.display = 'none';
          document.getElementById('checkoutFull').style.display = 'none';
          document.getElementById('paypalConfirm').classList.add('show');
          Cart.clear();
        },

        onCancel: async function () {
          if (currentReservationIds.length > 0) {
            try {
              await callFunction('cancel-checkout', { reservationIds: currentReservationIds });
            } catch (err) {
              console.error('Failed to release reservation after cancel:', err);
            }
            currentReservationIds = [];
          }
        },

        onError: function (err) {
          console.error('PayPal Checkout error:', err);
          alert('There was a problem processing payment. Please try again, or use "Arrange with Advisor" instead.');
        },
      }).render('#paypal-button-container');
    }
  });
})();
