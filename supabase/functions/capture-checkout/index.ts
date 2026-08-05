// POST /capture-checkout
// Body: { paypalOrderId, reservationIds }
// Returns: { orderId }
//
// Called once the customer approves payment in the PayPal popup. Captures
// the payment via PayPal, then calls complete_order() — the single atomic
// database call that creates the order, its line items, and the payment
// record together, or rolls all of it back. See complete_order() in the
// schema for the idempotency and price-verification guarantees this
// relies on.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { capturePayPalOrder, getPayPalAccessToken } from "../_shared/paypal.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const { paypalOrderId, reservationIds } = await req.json();

    if (!paypalOrderId || !Array.isArray(reservationIds) || reservationIds.length === 0) {
      return new Response(JSON.stringify({ error: "Missing checkout details" }), { status: 400, headers: jsonHeaders });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Pull back the contact info stored at create-checkout time — see
    // migration 006. Using the stored copy (not fresh request data) keeps
    // this path and the webhook path consistent with each other.
    const { data: reservation, error: resError } = await supabase
      .from("inventory_reservations")
      .select("checkout_contact")
      .eq("id", reservationIds[0])
      .single();

    if (resError || !reservation) {
      return new Response(JSON.stringify({ error: "Reservation not found" }), { status: 404, headers: jsonHeaders });
    }

    const contact = reservation.checkout_contact ?? {};

    const accessToken = await getPayPalAccessToken();
    const capture = await capturePayPalOrder(accessToken, paypalOrderId);

    if (capture.status !== "COMPLETED") {
      return new Response(
        JSON.stringify({ error: `Payment not completed (status: ${capture.status})` }),
        { status: 402, headers: jsonHeaders },
      );
    }

    const purchaseUnit = capture.purchase_units[0];
    const captureDetail = purchaseUnit.payments.captures[0];
    const amountCents = Math.round(parseFloat(captureDetail.amount.value) * 100);
    const currency = captureDetail.amount.currency_code;
    const payerId = capture.payer?.payer_id ?? null;

    const { data: orderId, error } = await supabase.rpc("complete_order", {
      p_reservation_ids: reservationIds,
      p_guest_name: contact.guestName ?? null,
      p_guest_email: contact.guestEmail ?? null,
      p_guest_phone: contact.guestPhone ?? null,
      p_delivery_address: contact.deliveryAddress ?? null,
      p_customer_id: null,
      p_payment_method: "paypal",
      p_provider_order_id: paypalOrderId,
      p_provider_capture_id: captureDetail.id,
      p_provider_payer_id: payerId,
      p_amount_cents: amountCents,
      p_currency: currency,
    });

    if (error) {
      // PayPal has already taken the money by this point. This is exactly
      // the gap complete_order()'s idempotency-by-capture-id guard exists
      // for: the PayPal webhook (paypal-webhook function) will retry this
      // same capture ID independently and safely finish the order even if
      // this response never reaches the browser.
      console.error("complete_order failed after successful PayPal capture:", error, {
        paypalOrderId,
        captureId: captureDetail.id,
      });
      return new Response(
        JSON.stringify({
          error: "Payment succeeded but order finalization is still processing — check your email shortly, or contact us with this reference: " + captureDetail.id,
        }),
        { status: 202, headers: jsonHeaders },
      );
    }

    return new Response(JSON.stringify({ orderId }), { headers: jsonHeaders });
  } catch (err) {
    console.error("capture-checkout error:", err);
    return new Response(JSON.stringify({ error: "Unable to complete checkout" }), { status: 500, headers: jsonHeaders });
  }
});
