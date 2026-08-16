/* Jade You — Supabase configuration
   Fill these in once you've created your Supabase project (Settings ->
   API in the Supabase dashboard). The anon key is safe to expose in
   frontend code — it's the public key, and every table it can touch is
   protected by Row Level Security. Never put the service_role key here or
   anywhere in frontend code; it bypasses RLS entirely and belongs only in
   Supabase's Edge Function secrets. */
window.SUPABASE_URL = "https://iuqetedvpzijfpdpdoxf.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_InhtvZvEcKxxh7a_6XGPhg_3QpjAK42";

/* Edge Functions are served under the same project URL, at /functions/v1/. */
window.SUPABASE_FUNCTIONS_URL = window.SUPABASE_URL + "/functions/v1";
