export const DEMO_PRESETS = {
  small: {
    id: "small",
    label: "Kleine Demo",
    scale: 5,
    teams: 2,
    employees: 5,
    companies: 5,
    contacts: 8,
    projects: 5,
    tasks: 5,
    appointments: 5,
    projectTypes: 3,
    taskTypes: 4,
  },
  medium: {
    id: "medium",
    label: "Mittlere Demo",
    scale: 50,
    teams: 4,
    employees: 16,
    companies: 12,
    contacts: 30,
    projects: 12,
    tasks: 50,
    appointments: 12,
    projectTypes: 4,
    taskTypes: 6,
  },
  large: {
    id: "large",
    label: "Große Demo",
    scale: 500,
    teams: 8,
    employees: 40,
    companies: 30,
    contacts: 80,
    projects: 30,
    tasks: 500,
    appointments: 40,
    projectTypes: 5,
    taskTypes: 8,
  },
} as const

export type DemoPresetId = keyof typeof DEMO_PRESETS
export type DemoPreset = (typeof DEMO_PRESETS)[DemoPresetId]

export function presetById(id: DemoPresetId): DemoPreset {
  return DEMO_PRESETS[id]
}
