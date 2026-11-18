import { z } from "zod"

import type { DemoPresetId } from "@/lib/demo-presets"
import { TASK_FIELD_TYPES } from "@/lib/task-fields"

export const DEMO_PASSWORD = "Demo2026!"

export const languageSchema = z.enum(["de", "en"])
export const presetIdSchema = z.enum(["small", "medium", "large"])
export const statusCategorySchema = z.enum(["Todo", "InProgress", "Done"])
export const prioritySchema = z.enum([
  "Highest",
  "High",
  "Medium",
  "Low",
  "Lowest",
])

const namedTypeSchema = z.object({
  displayName: z.string().min(1),
  rationale: z.string().min(1),
})

const taskFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  valueType: z.enum(TASK_FIELD_TYPES),
  helpText: z.string(),
  options: z.array(z.string()),
})

const taskStatusSchema = z.object({
  name: z.string().min(1),
  category: statusCategorySchema,
})

const taskTypeSchema = z.object({
  displayName: z.string().min(1),
  rationale: z.string().min(1),
  fields: z.array(taskFieldSchema).default([]),
  statuses: z.array(taskStatusSchema).default([]),
})

export const demoPlanSchema = z.object({
  language: languageSchema,
  profile: z.string().min(1),
  presetId: presetIdSchema,
  projectTypes: z.array(namedTypeSchema).min(1),
  taskTypes: z.array(taskTypeSchema).min(1),
  companies: z.array(
    z.object({
      name: z.string().min(1),
      street: z.string(),
      zipCode: z.string(),
      city: z.string(),
      country: z.string(),
      phone: z.string(),
      email: z.string().email(),
      note: z.string(),
    })
  ).default([]),
  contacts: z.array(
    z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      position: z.string().min(1),
      department: z.string(),
      companyIndex: z.number().int().nonnegative(),
      phone: z.string(),
      email: z.string().email(),
    })
  ).default([]),
  teams: z.array(
    z.object({
      name: z.string().min(1),
      purpose: z.string().min(1),
    })
  ).min(1),
  employees: z.array(
    z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      position: z.string().min(1),
      teamIndex: z.number().int().nonnegative(),
      email: z.string().email(),
    })
  ).min(1),
  projects: z.array(
    z.object({
      name: z.string().min(1),
      summary: z.string().min(1),
      projectTypeIndex: z.number().int().nonnegative(),
      companyIndex: z.number().int().nonnegative().default(0),
      taskTypeIndex: z.number().int().nonnegative().default(0),
      managerIndex: z.number().int().nonnegative(),
      teamIndex: z.number().int().nonnegative(),
      startDate: z.string(),
      endDate: z.string(),
    })
  ).min(1),
  tasks: z.array(
    z.object({
      subject: z.string().min(1),
      description: z.string().min(1),
      projectIndex: z.number().int().nonnegative(),
      taskTypeIndex: z.number().int().nonnegative(),
      assigneeIndex: z.number().int().nonnegative(),
      statusCategory: statusCategorySchema,
      statusName: z.string().default(""),
      priority: prioritySchema,
      startDate: z.string(),
      dueDate: z.string(),
      file: z
        .object({
          name: z.string().min(1),
          kind: z.enum(["pdf", "docx"]),
          versions: z.number().int().min(1).max(3),
        })
        .optional(),
      fieldValues: z
        .array(
          z.object({
            key: z.string(),
            value: z.string(),
          })
        )
        .default([]),
    })
  ),
  appointments: z.array(
    z.object({
      title: z.string().min(1),
      location: z.string(),
      projectIndex: z.number().int().nonnegative(),
      startDate: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      attendeeIndexes: z.array(z.number().int().nonnegative()),
    })
  ),
})

export type DemoPlan = z.infer<typeof demoPlanSchema>
export type DemoLanguage = z.infer<typeof languageSchema>

export type GenerateRequest = {
  language: DemoLanguage
  profile: string
  presetId: DemoPresetId
  apiKey?: string
}

export function todayInBerlin(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(0, Math.trunc(index)), length - 1)
}

export function slugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
}

export function uniqueCompanyEmail(name: string, used: Set<string>): string {
  const stem = slugPart(name) || "firma"
  let local = stem
  let suffix = 2
  while (used.has(local)) {
    local = `${stem}.${suffix}`
    suffix += 1
  }
  used.add(local)
  return `${local}@example.com`
}

export function uniqueEmail(
  firstName: string,
  lastName: string,
  used: Set<string>
): string {
  const base = [slugPart(firstName), slugPart(lastName)].filter(Boolean).join(".")
  const stem = base || "mitarbeiter"
  let local = stem
  let suffix = 2
  while (used.has(local)) {
    local = `${stem}.${suffix}`
    suffix += 1
  }
  used.add(local)
  return `${local}@example.com`
}

export function instanceAppUrl(graphqlUrl: string): string {
  const url = new URL(graphqlUrl)
  url.pathname = url.pathname.replace(/\/graphql\/?$/, "") || "/"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

export function normalizeGraphqlUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error("Die Instanz-URL ist ungültig.")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Die URL muss mit http:// oder https:// beginnen.")
  }
  const path = url.pathname.replace(/\/$/, "")
  url.pathname = path.endsWith("/graphql") ? path : `${path}/graphql`
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}
