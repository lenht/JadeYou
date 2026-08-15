// POST /create-checkout
// Body: { items: [{slug, quantity}], guestName, guestEmail, guestPhone, deliveryAddress }
// Returns: { paypalOrderId, reservationIds, subtotalCents }
//
// This is the first of two calls the PayPal flow makes (create-checkout,
// then capture-checkout). Everything that matters for security happens
// here: prices come from the database, never from the request body, and
// stock is reserved BEFORE PayPal is ever contacted — that ordering is
// what actually prevents two people from both paying for the same
// one-of-a-kind piece. See reserve_stock()/available_stock() in the
// schema for why.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { createPayPalOrder, getPayPalAccessToken } from "../_shared/paypal.ts";

const HOLD_MINUTES_PAYPAL = 15;

interface CartItem {
  slug: string;
  quantity: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const body = await req.json();
    const items: CartItem[] = body.items ?? [];
    const guestName: string | null = body.guestName ?? null;
    const guestEmail: string | null = body.guestEmail ?? null;
    const guestPhone: string | null = body.guestPhone ?? null;
    const deliveryAddress: unknown = body.deliveryAddress ?? null;

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: "Cart is empty" }), { status: 400, headers: jsonHeaders });
    }
    if (!guestName || !guestEmail) {
      return new Response(JSON.stringify({ error: "Name and email are required" }), { status: 400, headers: jsonHeaders });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const slugs = items.map((i) => i.slug);
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id, slug, price_cents, is_active")
      .in("slug", slugs);

    if (productsError) throw productsError;

    const productBySlug = new Map(products!.map((p) => [p.slug, p]));
    const reservationIds: string[] = [];

    async function releaseAll() {
      for (const id of reservationIds) {
        await supabase.rpc("cancel_reservation", { p_reservation_id: id });
      }
    }

    let subtotalCents = 0;

    for (const item of items) {
      const product = productBySlug.get(item.slug);

      if (!product || !product.is_active) {
        await releaseAll();
        return new Response(JSON.stringify({ error: `Product not available: ${item.slug}` }), { status: 400, headers: jsonHeaders });
      }
      if (product.price_cents === null) {
        await releaseAll();
        return new Response(
          JSON.stringify({ error: `${item.slug} is contact-for-price and can't go through PayPal checkout` }),
          { status: 400, headers: jsonHeaders },
        );
      }

      const quantity = Math.max(1, Math.floor(Number(item.quantity)) || 1);

      const { data: reservationId, error: reserveError } = await supabase.rpc("reserve_stock", {
        p_product_id: product.id,
        p_quantity: quantity,
        p_hold_minutes: HOLD_MINUTES_PAYPAL,
      });

      if (reserveError) {
        await releaseAll();
        return new Response(
          JSON.stringify({ error: `${item.slug} is no longer available: ${reserveError.message}` }),
          { status: 409, headers: jsonHeaders },
        );
      }

      reservationIds.push(reservationId as string);
      subtotalCents += product.price_cents * quantity;
    }

    const accessToken = await getPayPalAccessToken();
    const paypalOrder = await createPayPalOrder(accessToken, subtotalCents, "USD");

    // Store both the PayPal correlation and the contact info now, while
    // the browser is definitely still here — see migration 006 for why.
    const { error: updateError } = await supabase
      .from("inventory_reservations")
      .update({
        provider_order_id: paypalOrder.id,
        checkout_contact: { guestName, guestEmail, guestPhone, deliveryAddress },
      })
      .in("id", reservationIds);

    if (updateError) {
      await releaseAll();
      throw updateError;
    }

    return new Response(
      JSON.stringify({ paypalOrderId: paypalOrder.id, reservationIds, subtotalCents }),
      { headers: jsonHeaders },
    );
  } catch (err) {
    console.error("create-checkout error:", err);
    return new Response(JSON.stringify({ error: "Unable to start checkout" }), { status: 500, headers: jsonHeaders });
  }
});
