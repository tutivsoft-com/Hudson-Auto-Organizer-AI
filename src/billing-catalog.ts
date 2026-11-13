import { diagnostics } from "./diagnostics";
import { Setting, requestUrl } from "obsidian";
import { refreshBillingSession } from "./constance-account";
import { openAccountCheckout, prepareAccountCheckout, resumeAccountCheckout, recoverAccountCheckout, cancelAccountCheckout } from "./billing-checkout";
import { CONSTANCE_API, BILLING_UNIT } from "./constance-v2";
import { joinPublicPacks } from "./billing-offers";
interface BillingCatalogHost { appId: string; installationId: string; state: any; persist(): Promise<void>; syncBalance(): Promise<void>; resumeCheckout?(): void }
/** Only server offers granting this app's metered unit can become purchase buttons. */
export { joinPublicPacks } from "./billing-offers";
export function addLivePacks(root: HTMLElement, host: BillingCatalogHost): void {
  const checkoutHost = { ...host, preparationRoot: undefined as HTMLElement | undefined, syncBalance: async () => { await host.syncBalance(); }, refreshSession: () => refreshBillingSession(host.state, host.persist) };
  resumeAccountCheckout(checkoutHost);
  let selectedCurrency = "USD";
  let renderOffers = () => {};
  const section = root.createDiv({ cls: "ui-billing-packs" });
  new Setting(section).setName("Currency").addDropdown(dropdown => {
    dropdown.addOption("USD", "USD");
    dropdown.setValue("USD").onChange(value => { selectedCurrency = value; renderOffers(); });
  });
  const status = section.createEl("p", { text: "Loading prices..." });
  const packs = section.createDiv();
  checkoutHost.preparationRoot = section.createDiv({cls:'checkout-payment-status'});
  if(host.state.pendingAccountCheckout)prepareAccountCheckout(checkoutHost);
  void diagnostics.guard("billing-catalog.load", async () => {
    try {
      const response = await requestUrl({ url: `${CONSTANCE_API}/billing/offers?app_id=${encodeURIComponent(host.appId)}`, method: "GET", throw: false });
      if (response.status !== 200) throw new Error("Prices unavailable");
      const offers = joinPublicPacks(response.json?.data, host.appId);
      if (!offers.length) throw new Error("Prices unavailable");
      renderOffers = () => {
      packs.empty();
      const matching = offers.filter(offer => offer.pack.currency === selectedCurrency);
      status.setText(matching.length ? "Applicable taxes are calculated at checkout." : "No packs available in this currency.");
      for (const { pack, priceId, units, unit, amount, available } of matching.sort((a, b) => a.units - b.units)) {
        new Setting(packs).setName(pack.name || "Credit offer").setDesc(`${pack.description ? pack.description.replace(/[.!?]$/, "") + ". " : ""}Applicable taxes are calculated at checkout.`).addButton(button => button.setButtonText(available ? `Buy ${amount}` : "Pricing unavailable").setDisabled(!available || !host.state.billingAccountLinked).onClick(async () => {
          button.setDisabled(true);
          try { await openAccountCheckout(checkoutHost, priceId); } finally { button.setDisabled(!available || !host.state.billingAccountLinked); }
        }));
      }
      };
      renderOffers();
      if (!host.state.billingAccountLinked) status.setText('Connect your account above to buy credits. Applicable taxes are calculated at checkout.');
    } catch (error) { diagnostics.failure("billing-catalog.load", error); status.setText("Pricing temporarily unavailable. Refresh before buying."); }
  });
}
