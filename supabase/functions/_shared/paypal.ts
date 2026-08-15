// Thin wrapper around PayPal's REST API (Orders v2 + Webhooks v1). No SDK
// dependency — PayPal doesn't publish an official Deno SDK, and the REST
// surface used here is small enough that a raw fetch wrapper is more
// transparent than pulling in a third-party npm PayPal SDK.
//
// PAYPAL_API_BASE controls sandbox vs. live:
//   sandbox: https://api-m.sandbox.paypal.com
//   live:    https://api-m.paypal.com
// Defaults to sandbox so a missing env var fails safe (test mode) rather
// than accidentally going live.

const PAYPAL_API_BASE = Deno.env.get("PAYPAL_API_BASE") ?? "https://api-m.sandbox.paypal.com";
const PAYPAL_CLIENT_ID = Deno.env.get("PAYPAL_CLIENT_ID")!;
const PAYPAL_CLIENT_SECRET = Deno.env.get("PAYPAL_CLIENT_SECRET")!;
const PAYPAL_WEBHOOK_ID = Deno.env.get("PAYPAL_WEBHOOK_ID");

export async function getPayPalAccessToken(): Promise<string> {
  const credentials = btoa(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`);

  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token as string;
}

// amountCents is the smallest currency unit (cents) as an integer.
// PayPal's Orders API wants a decimal string.
// For USD, 128000 cents = "1280.00".
export async function createPayPalOrder(
  accessToken: string,
  amountCents: number,
  currency: string,
): Promise<{ id: string }> {
  const value = (amountCents / 100).toFixed(2);

  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: currency, value },
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal order creation failed (${res.status}): ${text}`);
  }

  return await res.json();
}

export async function capturePayPalOrder(
  accessToken: string,
  paypalOrderId: string,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`PayPal capture failed (${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

// Verifies an incoming webhook actually came from PayPal, using PayPal's
// own verification endpoint rather than reimplementing the signature
// crypto by hand. Requires PAYPAL_WEBHOOK_ID (the ID PayPal assigns your
// webhook subscription in the developer dashboard, not a secret you
// choose yourself).
export async function verifyWebhookSignature(
  accessToken: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID) {
    console.error("PAYPAL_WEBHOOK_ID is not set — refusing to accept an unverifiable webhook");
    return false;
  }

  const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: JSON.parse(rawBody),
    }),
  });

  if (!res.ok) {
    console.error("Webhook verification request itself failed:", res.status, await res.text());
    return false;
  }

  const data = await res.json();
  return data.verification_status === "SUCCESS";
}
