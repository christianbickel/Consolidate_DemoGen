export const TASK_FIELD_TYPES = [
  "Text",
  "Number",
  "Date",
  "Checkbox",
  "Time",
  "ComboBox",
] as const

export type TaskFieldType = (typeof TASK_FIELD_TYPES)[number]

export type TaskFieldDefinition = {
  key: string
  label: string
  valueType: TaskFieldType
  helpText: string
  options: string[]
}

const RESERVED_KEYS = new Set([
  "subject",
  "status",
  "responsible",
  "project",
  "startdate",
  "duedate",
  "priority",
  "description",
  "tags",
  "parent",
  "rank",
  "name",
  "type",
])

export function assignFieldKey(label: string, used: Set<string>): string {
  const parts = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const base = parts
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
    .join("")
  let key = /^[A-Za-z]/.test(base) ? base : `feld${base}`
  if (!key) key = "feld"
  let candidate = key
  let suffix = 2
  while (used.has(candidate.toLowerCase()) || RESERVED_KEYS.has(candidate.toLowerCase())) {
    candidate = `${key}${suffix}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export function normalizeTaskFields(
  fields: {
    label: string
    valueType: TaskFieldType
    helpText: string
    options: string[]
  }[],
  used: Set<string>
): TaskFieldDefinition[] {
  const normalized: TaskFieldDefinition[] = []
  for (const field of fields.slice(0, 3)) {
    const label = field.label.trim().slice(0, 60)
    if (!label) continue
    const options = field.options.map((option) => option.trim()).filter(Boolean).slice(0, 6)
    const valueType = field.valueType === "ComboBox" && options.length < 2 ? "Text" : field.valueType
    normalized.push({
      key: assignFieldKey(label, used),
      label,
      valueType,
      helpText: field.helpText.trim().slice(0, 160),
      options: valueType === "ComboBox" ? options : [],
    })
  }
  return normalized
}

export function fallbackFieldValue(
  field: TaskFieldDefinition,
  dueDate: string,
  language: "de" | "en",
  index: number
): string {
  switch (field.valueType) {
    case "Number":
      return String(4 + (index % 12))
    case "Checkbox":
      return "true"
    case "Date":
      return dueDate
    case "Time":
      return "10:00"
    case "ComboBox":
      return field.options[index % Math.max(field.options.length, 1)] ?? ""
    default:
      return language === "de" ? "gemäß Auftrag" : "as specified"
  }
}

export function storedFieldValue(
  field: TaskFieldDefinition,
  raw: string,
  dueDate: string,
  language: "de" | "en",
  index: number
): string {
  const value = raw.trim()
  if (toGraphqlFieldValue(field, value) === undefined) {
    return fallbackFieldValue(field, dueDate, language, index)
  }
  if (field.valueType === "Checkbox") {
    return ["true", "ja", "yes", "1"].includes(value.toLowerCase()) ? "true" : "false"
  }
  if (field.valueType === "Time") {
    const match = /^(\d{2}):(\d{2})/.exec(value)
    return match ? `${match[1]}:${match[2]}` : fallbackFieldValue(field, dueDate, language, index)
  }
  if (field.valueType === "ComboBox") {
    return (
      field.options.find((option) => option.toLowerCase() === value.toLowerCase()) ??
      fallbackFieldValue(field, dueDate, language, index)
    )
  }
  return value
}

export function toGraphqlFieldValue(
  field: TaskFieldDefinition,
  raw: string
): string | number | boolean | undefined {
  const value = raw.trim()
  if (!value) return undefined
  switch (field.valueType) {
    case "Number": {
      const number = Number(value.replace(",", "."))
      return Number.isFinite(number) ? number : undefined
    }
    case "Checkbox": {
      const normalized = value.toLowerCase()
      if (["true", "ja", "yes", "1"].includes(normalized)) return true
      if (["false", "nein", "no", "0"].includes(normalized)) return false
      return undefined
    }
    case "Date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
    case "Time": {
      const match = /^(\d{2}):(\d{2})/.exec(value)
      if (!match) return undefined
      const hours = Number(match[1])
      const minutes = Number(match[2])
      if (hours > 23 || minutes > 59) return undefined
      return `${match[1]}:${match[2]}:00`
    }
    case "ComboBox": {
      const index = field.options.findIndex(
        (option) => option.toLowerCase() === value.toLowerCase()
      )
      return index >= 0 ? index : undefined
    }
    default:
      return value.slice(0, 500)
  }
}
