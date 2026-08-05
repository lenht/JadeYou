// Shared CORS headers for every browser-facing edge function.
// paypal-webhook does NOT import this — that endpoint is only ever called
// server-to-server by PayPal, never by a browser, so it doesn't need CORS
// at all (and shouldn't invite browser calls to it).
//
// FRONTEND_ORIGIN should be your real GitHub Pages URL (or custom domain)
// once you've deployed, e.g. "https://yourname.github.io". Using "*" while
// developing locally is fine; tighten it before going live.
export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("FRONTEND_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
