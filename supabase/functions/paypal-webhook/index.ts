// POST /paypal-webhook  (configured in the PayPal developer dashboard, not
// called by the browser — see the CORS note below)
//
// This is the reconciliation path complete_order()'s idempotency-by-
// capture-id guard exists for: if capture-checkout's response never makes
// it back to the browser (closed tab, dropped connection, function crash)
// after PayPal has already taken the money, this is what eventually
// finishes the order anyway. PayPal retries webhook delivery on failure
// and may deliver the same event more than once by design — both of
// those are exactly what complete_order()'s idempotency check makes safe.
//
// No CORS headers on this file on purpose: this endpoint is only ever
// called server-to-server by PayPal, and should never accept a browser
// request in the first place.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getPayPalAccessToken, verifyWebhookSignature } from "../_shared/paypal.ts";

Deno.serve(async (req: Request) => {
  try {
    const rawBody = await req.text();
    const event = JSON.parse(rawBody);

    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => (headers[key] = value));

    const accessToken = await getPayPalAccessToken();
    const verified = await verifyWebhookSignature(accessToken, headers, rawBody);

    if (!verified) {
      console.error("PayPal webhook signature verification failed");
      return new Response("Invalid signature", { status: 400 });
    }

    if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
      // Not an event this handler needs to act on — acknowledge so PayPal
      // doesn't keep retrying delivery of it.
      return new Response("ok", { status: 200 });
    }

    const resource = event.resource;
    const captureId: string = resource.id;
    const paypalOrderId: string | undefined = resource.supplementary_data?.related_ids?.order_id;
    const amountCents = Math.round(parseFloat(resource.amount.value) * 100);
    const currency: string = resource.amount.currency_code;
    const payerId: string | null = resource.payer?.payer_id ?? null;

    if (!paypalOrderId) {
      console.error("Webhook capture event missing related PayPal order id", captureId);
      return new Response("ok", { status: 200 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Recover the reservation set — and the contact info stored at
    // checkout time — using only the PayPal order id. See migration 006.
    const { data: reservations, error: resError } = await supabase
      .from("inventory_reservations")
      .select("id, checkout_contact")
      .eq("provider_order_id", paypalOrderId);

    if (resError || !reservations || reservations.length === 0) {
      console.error("Webhook could not find reservations for PayPal order", paypalOrderId, resError);
      return new Response("ok", { status: 200 });
    }

    const reservationIds = reservations.map((r) => r.id);
    // deno-lint-ignore no-explicit-any
    const contact = (reservations[0].checkout_contact ?? {}) as any;

    const { error } = await supabase.rpc("complete_order", {
      p_reservation_ids: reservationIds,
      p_guest_name: contact.guestName ?? null,
      p_guest_email: contact.guestEmail ?? null,
      p_guest_phone: contact.guestPhone ?? null,
      p_delivery_address: contact.deliveryAddress ?? null,
      p_customer_id: null,
      p_payment_method: "paypal",
      p_provider_order_id: paypalOrderId,
      p_provider_capture_id: captureId,
      p_provider_payer_id: payerId,
      p_amount_cents: amountCents,
      p_currency: currency,
    });

    if (error) {
      // Safe to have happened already (complete_order is idempotent on
      // capture id, so a normal "already completed by the direct path"
      // case doesn't even reach here — it returns success). A real error
      // here — e.g. the reservation genuinely expired before either path
      // ever completed it — needs a human, not an infinite PayPal retry
      // loop, so this still acknowledges with 200 rather than 500.
      console.error("Webhook complete_order failed:", error, { paypalOrderId, captureId });
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("paypal-webhook error:", err);
    // A genuine unexpected failure (bad JSON, PayPal's own verification
    // endpoint unreachable, etc.) SHOULD be retried — this is the one case
    // that returns non-200 on purpose, so PayPal tries delivery again.
    return new Response("error", { status: 500 });
  }
});
