// POST /cancel-checkout
// Body: { reservationIds }
// Returns: { ok: true }
//
// Called when a customer closes the PayPal popup instead of paying, so
// the stock hold releases immediately instead of sitting for the full
// 15-minute expiry window before someone else can buy it.
//
// No ownership check against a customer/session identity here — there
// isn't one to check against in a guest-checkout design. What stands in
// for it: reservation IDs are random UUIDs (122 bits of entropy) that are
// only ever handed back to the browser that created them, in the
// create-checkout response. Knowing the ID is what authorizes cancelling
// it, the same bearer-token pattern a password-reset link uses. Low
// stakes either way: the worst case of a leaked ID is someone's stock
// hold released a few minutes early, not a financial loss.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const { reservationIds } = await req.json();

    if (!Array.isArray(reservationIds)) {
      return new Response(JSON.stringify({ error: "Missing reservationIds" }), { status: 400, headers: jsonHeaders });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    for (const id of reservationIds) {
      await supabase.rpc("cancel_reservation", { p_reservation_id: id });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
  } catch (err) {
    console.error("cancel-checkout error:", err);
    return new Response(JSON.stringify({ error: "Unable to cancel checkout" }), { status: 500, headers: jsonHeaders });
  }
});
