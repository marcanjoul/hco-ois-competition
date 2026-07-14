// src/stores.js
// Valid stores. Adding a store = one new line here.
export const STORES = {
  wiregrass: "HCO Wiregrass",
  ipanf: "IP AnF",
};

// Resolves the store for this session from the URL path.
// Returns a valid storeId, or null (show the picker). Deliberately no
// localStorage memory — landing on "/" always means picking a store.
export function resolveStore() {
  const path = window.location.pathname.replace(/\/+$/, "").slice(1);
  return STORES[path] ? path : null;
}
