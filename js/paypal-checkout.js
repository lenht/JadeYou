/* Jade You — checkout payment logic.
   Handles the Pay Now (PayPal) / Arrange with Advisor tabs, gates the PayPal
   button behind basic contact-form validation, and renders PayPal's Smart
   Buttons (which include Visa/Mastercard/Amex via PayPal's own guest card
   checkout — no separate card processor needed).

   IMPORTANT: this runs against PayPal's public sandbox client-id ("sb"), so
   no real money moves. To go live: create a PayPal Business account, grab a
   Live Client ID from developer.paypal.com/dashboard/applications, and swap
   it into the PayPal SDK <script> tag's client-id parameter in checkout.html.
   For production-grade security PayPal also recommends creating/capturing
   orders from a small server endpoint rather than purely client-side (this
   build does it client-side, which works, but a static site has no server
   to move that logic to). */

(function(){
  function fmt(n){ return 'HK$' + Number(n).toLocaleString('en-US'); }

  document.addEventListener('DOMContentLoaded', function(){
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
    function checkFormValid(){
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

    // ---------- render PayPal Smart Buttons ----------
    if (window.paypal && document.getElementById('paypal-button-container')) {
      paypal.Buttons({
        style: { color: 'black', shape: 'rect', label: 'pay', height: 45 },

        createOrder: function(data, actions){
          const total = (window.Cart ? Cart.subtotal() : 0);
          return actions.order.create({
            purchase_units: [{
              amount: {
                value: total.toFixed(2),
                currency_code: 'HKD'
              },
              description: 'Jade You reservation — ' + (window.Cart ? Cart.get().map(i=>i.ref).join(', ') : '')
            }]
          });
        },

        onClick: function(data, actions){
          if (!checkFormValid()) {
            alert('Please complete your name, email, and phone number before paying.');
            return actions.reject();
          }
          return actions.resolve();
        },

        onApprove: function(data, actions){
          return actions.order.capture().then(function(details){
            const amount = details.purchase_units[0].amount.value;
            const txId = details.id;
            document.getElementById('paypalConfirmDetail').textContent =
              'Thank you, ' + (details.payer.name.given_name || '') + ' — your PayPal payment of HK$' + Number(amount).toLocaleString('en-US') + ' is complete. Transaction ID: ' + txId;

            const items = Cart.get();
            const lines = items.map(i => `  • ${i.name} (${i.ref}) × ${i.qty}`).join('\n');
            const subject = encodeURIComponent('Paid Order — PayPal Transaction ' + txId);
            const body = encodeURIComponent(
              `Hello Jade You,\n\nI've completed payment via PayPal for the following piece(s):\n\n${lines}\n\nPayPal Transaction ID: ${txId}\nAmount Paid: HK$${amount}\n\nPlease confirm dispatch or arrange a collection appointment.\n\nName: ${document.getElementById('coName').value}\nPhone: ${document.getElementById('coPhone').value}\nDelivery / Appointment Address: ${document.getElementById('coAddress').value}`
            );
            const notifyBtn = document.getElementById('paypalNotifyBtn');
            if (notifyBtn) notifyBtn.href = 'mailto:hello@jadeyou.com?subject=' + subject + '&body=' + body;

            document.getElementById('checkoutFull').style.display = 'none';
            document.getElementById('paypalConfirm').classList.add('show');
            Cart.clear();
          });
        },

        onError: function(err){
          console.error('PayPal Checkout error:', err);
          alert('There was a problem processing payment. Please try again, or use "Arrange with Advisor" instead.');
        }

      }).render('#paypal-button-container');
    }
  });
})();
