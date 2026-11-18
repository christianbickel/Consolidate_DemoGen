export const DEMO_WIPE_ERROR = "Leeren ist nur für demo- und uxawards-Instanzen erlaubt!"

const WIPE_URL_MARKERS = ["demo", "uxawards"]

export function instanceAllowsWipe(instanceUrl: string): boolean {
  const url = instanceUrl.toLowerCase()
  return WIPE_URL_MARKERS.some((marker) => url.includes(marker))
}
