/**
 * Every customer-visible use of the product name comes from here.
 * The name is provisional until launch; see RENAMING.md for the few places
 * outside this module (npm package name, bin name, Worker names) that also change.
 */
export const BRAND = {
  /** CLI command, npm package name and display name. */
  name: "printsi",
  /** Prefix for CLI environment variables, e.g. PRINTSI_TOKEN. */
  envPrefix: "PRINTSI_",
  /** Lower-case header prefix, e.g. Printsi-Version. */
  headerPrefix: "Printsi",
  /**
   * Where each environment lives. No custom domain yet (spec 11, D9): the API is on workers.dev and the site on Vercel.
   * Approval links are served by the API itself.
   */
  domains: {
    live: {
      api: "https://printsi-api-live.magnus-ahmad.workers.dev",
      pay: "https://printsi-api-live.magnus-ahmad.workers.dev",
      site: "https://getprintsi.vercel.app",
    },
    sandbox: {
      api: "https://printsi-api-sandbox.magnus-ahmad.workers.dev",
      pay: "https://printsi-api-sandbox.magnus-ahmad.workers.dev",
      site: "https://getprintsi.vercel.app",
    },
  },
} as const;

export type Env = keyof typeof BRAND.domains;

export const API_VERSION = "2026-11-01";

export const HEADERS = {
  version: `${BRAND.headerPrefix}-Version`,
  requestId: `${BRAND.headerPrefix}-Request-Id`,
  client: `${BRAND.headerPrefix}-Client`,
  latestCli: `${BRAND.headerPrefix}-Latest-CLI`,
  minCli: `${BRAND.headerPrefix}-Min-CLI`,
} as const;
