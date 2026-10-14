/*
 * Stock Room configuration.
 *
 * Leave supabaseUrl and supabaseAnonKey empty to keep data only in this
 * browser (no login needed).
 *
 * Fill both in to sign in and sync across phone + laptop with Supabase —
 * see README.md → "Cloud sync". The anon key is safe to publish: access is
 * protected by the row-level security rules in supabase/schema.sql.
 */
window.STOCKROOM_CONFIG = {
  supabaseUrl: "https://qcptwgmsmfcrvxmqkowv.supabase.co",
  supabaseAnonKey: "sb_publishable_HCUKXa5dPc342crg4E-7yA_ZSZzq06u",

  // Allow "Create account" on the sign-in screen. Set to false once you have
  // made your own account (and also disable sign-ups in Supabase).
  allowSignup: true,

  // Default low-stock threshold for new products.
  lowStockDefault: 5
};
