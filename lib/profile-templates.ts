const STORAGE_KEY = "consi-demo-profile-templates"
const MAX_TEMPLATES = 20

const listeners = new Set<() => void>()
const EMPTY_TEMPLATES: string[] = []
let cached: string[] = EMPTY_TEMPLATES
let loaded = false

function parseTemplates(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length >= 20)
      .slice(0, MAX_TEMPLATES)
  } catch {
    return []
  }
}

function readTemplates(): string[] {
  if (typeof window === "undefined") return EMPTY_TEMPLATES
  if (!loaded) {
    loaded = true
    const parsed = parseTemplates(window.localStorage.getItem(STORAGE_KEY))
    cached = parsed.length === 0 ? EMPTY_TEMPLATES : parsed
  }
  return cached
}

export function subscribeProfileTemplates(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProfileTemplates() {
  return readTemplates()
}

export function getServerProfileTemplates() {
  return EMPTY_TEMPLATES
}

export function rememberProfileTemplate(templates: string[], profile: string): string[] {
  const value = profile.trim()
  if (value.length < 20 || templates[0] === value) return templates
  return [value, ...templates.filter((item) => item !== value)].slice(0, MAX_TEMPLATES)
}

export function saveProfileTemplate(profile: string) {
  const next = rememberProfileTemplate(readTemplates(), profile)
  if (next === cached) return
  cached = next
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  listeners.forEach((listener) => listener())
}

export function profileTemplateLabel(profile: string): string {
  const line = profile.replace(/\s+/g, " ").trim()
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}
