import { clampIndex } from "@/lib/demo-plan"

export const STATUS_CATEGORIES = ["Todo", "InProgress", "Done"] as const
export type StatusCategory = (typeof STATUS_CATEGORIES)[number]

export type PlannedStatus = {
  name: string
  category: StatusCategory
}

const CATEGORY_ORDER: Record<StatusCategory, number> = {
  Todo: 0,
  InProgress: 1,
  Done: 2,
}

type WorkflowType = {
  displayName: string
  statuses: PlannedStatus[]
}

export function normalizeStatusWorkflows<T extends WorkflowType>(types: T[]): T[] {
  const cleaned = types.map((type) => ({
    ...type,
    statuses: cleanWorkflow(type.statuses),
  }))
  const selected = keepSomeWorkflows(cleaned)
  const used = new Set<string>()
  return selected.map((type) => ({
    ...type,
    statuses: type.statuses.map((status) => ({
      ...status,
      name: uniqueStatusName(status.name, type.displayName, used),
    })),
  }))
}

function cleanWorkflow(statuses: PlannedStatus[]): PlannedStatus[] {
  const unique: PlannedStatus[] = []
  const seen = new Set<string>()
  for (const status of statuses) {
    const name = status.name.trim().replace(/\s+/g, " ").slice(0, 40)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ name, category: status.category })
    if (unique.length === 5) break
  }
  unique.sort((left, right) => CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category])
  const hasTodo = unique.some((status) => status.category === "Todo")
  const hasDone = unique.some((status) => status.category === "Done")
  if (unique.length < 3 || !hasTodo || !hasDone) return []
  return unique
}

function keepSomeWorkflows<T extends WorkflowType>(types: T[]): T[] {
  const customCount = types.filter((type) => type.statuses.length > 0).length
  if (customCount < types.length || types.length < 2) return types
  const keep = Math.max(1, Math.floor(types.length / 2))
  const ranked = types
    .map((type, index) => ({
      index,
      stages: type.statuses.filter((status) => status.category === "InProgress").length,
    }))
    .sort((left, right) => right.stages - left.stages || left.index - right.index)
  const kept = new Set(ranked.slice(0, keep).map((entry) => entry.index))
  return types.map((type, index) => (kept.has(index) ? type : { ...type, statuses: [] }))
}

function uniqueStatusName(name: string, typeName: string, used: Set<string>): string {
  let candidate = name
  if (used.has(candidate.toLowerCase())) {
    const suffix = ` · ${typeName}`
    candidate = `${name.slice(0, Math.max(1, 40 - suffix.length))}${suffix}`.slice(0, 40)
  }
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    const ending = ` ${suffix}`
    candidate = `${name.slice(0, Math.max(1, 40 - ending.length))}${ending}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export function assignProjectTaskTypes<T extends { taskTypeIndex: number }>(
  projects: T[],
  taskTypes: { statuses: PlannedStatus[] }[]
): T[] {
  const next = projects.map((project) => ({
    ...project,
    taskTypeIndex: clampIndex(project.taskTypeIndex, taskTypes.length),
  }))
  const custom = taskTypes.flatMap((type, index) => (type.statuses.length > 0 ? [index] : []))
  for (const typeIndex of custom) {
    if (next.some((project) => project.taskTypeIndex === typeIndex)) continue
    const host = next.findIndex(
      (project) => (taskTypes[project.taskTypeIndex]?.statuses.length ?? 0) === 0
    )
    const target = host >= 0 ? host : typeIndex % next.length
    if (!next[target]) continue
    next[target] = { ...next[target], taskTypeIndex: typeIndex }
  }
  return next
}
