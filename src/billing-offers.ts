export const AUTO_ORGANIZER_APP_ID = "hudson-auto-organizer-ai";
export const BILLING_UNIT = "organize_runs";

export function joinPublicPacks(products: any, appId: string): any[] {
  if (products?.app_id !== appId || !Array.isArray(products.offers)) return [];
  return products.offers.filter((offer: any) => offer?.kind === "credits").map((pack: any) => {
    const priceId = typeof pack.code === "string" ? pack.code : "";
    const units = pack.grants?.units, unit = pack.grants?.unit;
    const available = !!priceId && unit === BILLING_UNIT && Number.isSafeInteger(units) && units > 0
      && Number.isInteger(pack.currency_exponent) && pack.currency_exponent >= 0 && pack.currency_exponent <= 4
      && Number.isSafeInteger(pack.amount) && pack.amount > 0 && typeof pack.currency === "string" && /^[A-Z]{3}$/.test(pack.currency);
    let amount = "";
    if (available) { try { amount = new Intl.NumberFormat(undefined, { style: "currency", currency: pack.currency }).format(pack.amount / (10 ** pack.currency_exponent)); } catch (_) { /* Invalid currency remains unavailable. */ } }
    return { pack, priceId, units, unit, amount, available: available && !!amount };
  });
}
