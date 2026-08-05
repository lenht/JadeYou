// POST /submit-advisor-order
// Body: { items, guestName, guestEmail, guestPhone, deliveryAddress, paymentMethod, notes }
// Returns: { orderId }
//
// The non-PayPal checkout path (Bank Transfer / Request Invoice / Pay In
// Person). Money doesn't move here at all — this just reserves stock and
// creates a pending order for staff to follow up on. Uses a 48-hour hold
// instead of PayPal's 15 minutes, since a bank transfer takes days to
// clear, not seconds — see create_pending_order() in the schema.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const HOLD_MINUTES_ADVISOR = 60 * 48; // 48 hours
const VALID_METHODS = ["bank_transfer", "invoice", "in_person"];

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
    const paymentMethod: string = body.paymentMethod;
    const notes: string | null = body.notes ?? null;

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: "Cart is empty" }), { status: 400, headers: jsonHeaders });
    }
    if (!VALID_METHODS.includes(paymentMethod)) {
      return new Response(JSON.stringify({ error: "Invalid payment method" }), { status: 400, headers: jsonHeaders });
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

    for (const item of items) {
      const product = productBySlug.get(item.slug);

      if (!product || !product.is_active || product.price_cents === null) {
        await releaseAll();
        return new Response(JSON.stringify({ error: `${item.slug} is not available for reservation` }), { status: 400, headers: jsonHeaders });
      }

      const quantity = Math.max(1, Math.floor(Number(item.quantity)) || 1);

      const { data: reservationId, error: reserveError } = await supabase.rpc("reserve_stock", {
        p_product_id: product.id,
        p_quantity: quantity,
        p_hold_minutes: HOLD_MINUTES_ADVISOR,
      });

      if (reserveError) {
        await releaseAll();
        return new Response(JSON.stringify({ error: `${item.slug} is no longer available` }), { status: 409, headers: jsonHeaders });
      }

      reservationIds.push(reservationId as string);
    }

    const { data: orderId, error: orderError } = await supabase.rpc("create_pending_order", {
      p_reservation_ids: reservationIds,
      p_guest_name: guestName,
      p_guest_email: guestEmail,
      p_guest_phone: guestPhone,
      p_delivery_address: deliveryAddress,
      p_customer_id: null,
      p_payment_method: paymentMethod,
      p_notes: notes,
    });

    if (orderError) {
      await releaseAll();
      throw orderError;
    }

    return new Response(JSON.stringify({ orderId }), { headers: jsonHeaders });
  } catch (err) {
    console.error("submit-advisor-order error:", err);
    return new Response(JSON.stringify({ error: "Unable to submit reservation request" }), { status: 500, headers: jsonHeaders });
  }
});
