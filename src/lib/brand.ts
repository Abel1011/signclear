// Single source of truth for product naming.
export const APP_NAME = "SignClear";
export const AGENT_NAME = "Clara";
export const TAGLINE = "understand your tax return before you pay your preparer";

/** Replace the working names in any UI string with the configured brand. */
export function brand(x: string) {
  return x.replaceAll("Firma Clara", APP_NAME).replaceAll("Clara", AGENT_NAME);
}
