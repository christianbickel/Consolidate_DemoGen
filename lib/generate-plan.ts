import OpenAI from "openai"
import { zodResponseFormat } from "openai/helpers/zod"
import { z } from "zod"

import {
  addDays,
  clampIndex,
  todayInBerlin,
  uniqueCompanyEmail,
  uniqueEmail,
  type DemoPlan,
  type GenerateRequest,
} from "@/lib/demo-plan"
import { assignTaskFiles } from "@/lib/demo-files"
import { presetById } from "@/lib/demo-presets"
import type { StreamEvent } from "@/lib/stream-events"
import { normalizeTaskFields, storedFieldValue } from "@/lib/task-fields"
import { assignProjectTaskTypes, normalizeStatusWorkflows } from "@/lib/task-statuses"

const TASK_BATCH = 25
const CONTACT_BATCH = 20

const typeSchema = z.object({
  displayName: z.string().describe("Short dropdown name in the target language, max 40 characters"),
  rationale: z.string().describe("Why this type fits the customer industry, one sentence"),
})

const generatedTaskTypeSchema = z.object({
  displayName: z.string().describe("Short dropdown name in the target language, max 40 characters"),
  rationale: z.string().describe("Why this type fits the customer industry, one sentence"),
  fields: z
    .array(
      z.object({
        label: z.string().describe("Field label shown on the task form, in the target language"),
        valueType: z.enum(["Text", "Number", "Date", "Checkbox", "Time", "ComboBox"]),
        helpText: z.string().describe("One short sentence explaining the field"),
        options: z
          .array(z.string())
          .max(6)
          .describe("ComboBox choices in the target language. Empty array for every other value type"),
      })
    )
    .min(1)
    .max(3),
  statuses: z
    .array(
      z.object({
        name: z.string().describe("Kanban column name in the target language, max 40 characters"),
        category: z.enum(["Todo", "InProgress", "Done"]),
      })
    )
    .max(5)
    .describe("Custom kanban columns for this task type. Empty when the type uses the instance default statuses"),
})

const companyShape = z.object({
  name: z.string(),
  street: z.string(),
  zipCode: z.string(),
  city: z.string(),
  country: z.string(),
  phone: z.string(),
  note: z.string().describe("One sentence on why this company is a customer or partner of the ICP"),
})

const externalContactShape = z.object({
  firstName: z.string(),
  lastName: z.string(),
  position: z.string(),
  department: z.string(),
  companyIndex: z.number().int(),
  phone: z.string(),
})

const teamShape = z.object({
  name: z.string(),
  purpose: z.string(),
})

const employeeShape = z.object({
  firstName: z.string(),
  lastName: z.string(),
  position: z.string(),
  teamIndex: z.number().int(),
})

const projectShape = z.object({
  name: z.string(),
  summary: z.string(),
  projectTypeIndex: z.number().int(),
  companyIndex: z.number().int(),
  managerIndex: z.number().int(),
  teamIndex: z.number().int(),
  startDate: z.string().describe("YYYY-MM-DD"),
  endDate: z.string().describe("YYYY-MM-DD"),
  taskTypeIndex: z.number().int().describe("The only task type tracked in this project"),
})

const taskShape = z.object({
  subject: z.string(),
  description: z.string(),
  projectIndex: z.number().int(),
  taskTypeIndex: z.number().int(),
  assigneeIndex: z.number().int(),
  statusCategory: z.enum(["Todo", "InProgress", "Done"]),
  statusName: z.string().describe("Exact column name of the project's task type, or empty when that type has no custom columns"),
  priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]),
  startDate: z.string(),
  dueDate: z.string(),
  fieldValues: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
      })
    )
    .max(3),
})

const appointmentShape = z.object({
  title: z.string(),
  location: z.string(),
  projectIndex: z.number().int(),
  startDate: z.string(),
  startTime: z.string().describe("HH:mm"),
  endTime: z.string().describe("HH:mm"),
  attendeeIndexes: z.array(z.number().int()).min(1).max(4),
})

function languageName(language: GenerateRequest["language"]): string {
  return language === "de" ? "German" : "English"
}

function industryRules(profile: string, language: GenerateRequest["language"]): string {
  return [
    `Write every user-facing string strictly in ${languageName(language)}.`,
    "The customer profile is the ideal customer profile (ICP).",
    "Project types, task types, companies, contacts, teams, job titles, project titles, task subjects and appointments must match that industry and the way that company works.",
    "Do not use software-development labels such as Bug, User Story, Sprint or Epic unless the profile is a software company.",
    "Do not use placeholder names such as Project 1, Team A or Task type.",
    `Customer profile: ${profile}`,
  ].join("\n")
}

async function complete<T>(
  client: OpenAI,
  model: string,
  schema: z.ZodType<T>,
  name: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await client.chat.completions.parse({
        model,
        temperature: 0.7,
        messages,
        response_format: zodResponseFormat(schema, name),
      })
      const parsed = completion.choices[0]?.message.parsed
      if (!parsed) {
        throw new Error(
          completion.choices[0]?.message.refusal ||
            "Das Modell hat keine gültige Struktur geliefert."
        )
      }
      return parsed
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Die KI-Generierung ist fehlgeschlagen.")
}

function asDate(value: string, fallback: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}

function asTime(value: string, fallback: string): string {
  const match = /^(\d{2}):(\d{2})/.exec(value)
  if (!match) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return `${match[1]}:${match[2]}:00`
}

export async function generateDemoPlan(
  request: GenerateRequest,
  emit: (event: StreamEvent) => void
): Promise<DemoPlan> {
  const preset = presetById(request.presetId)
  const apiKey = request.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("Kein OpenAI-API-Key. Trage ihn im Formular ein oder setze OPENAI_API_KEY.")
  }

  const client = new OpenAI({ apiKey })
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini"
  const today = todayInBerlin()
  const rules = industryRules(request.profile, request.language)
  const contactBatches = Math.max(1, Math.ceil(preset.contacts / CONTACT_BATCH))
  const steps = 5 + contactBatches + Math.ceil(preset.tasks / TASK_BATCH)
  let completed = 0

  const tick = (label: string) => {
    completed += 1
    emit({ type: "progress", completed, total: steps, label })
  }

  emit({
    type: "log",
    level: "info",
    message: `Erzeuge Branchenkonfiguration für eine ${preset.label} (${preset.tasks} Aufgaben).`,
  })

  const types = await complete(
    client,
    model,
    z.object({
      projectTypes: z.array(typeSchema).length(preset.projectTypes),
      taskTypes: z.array(generatedTaskTypeSchema).length(preset.taskTypes),
    }),
    "industry_types",
    [
      {
        role: "system",
        content:
          "You configure project types and task types for the Consolidate work-management product. Return only the schema.",
      },
      {
        role: "user",
        content: `${rules}
Create exactly ${preset.projectTypes} project types and ${preset.taskTypes} task types a consultant would configure for this ICP.
Project types are the kinds of projects this company runs.
Task types are the kinds of work people in that industry track inside those projects.
For each task type, add 1 to 3 additional data fields that someone doing that specific work would fill in.
The fields must fit both the industry and that task type. Do not copy the same fields onto every type.
A time budget, a measurement, a check, a deadline or a category are examples of the idea.
Use Scrum size estimates only when the profile is a software company.
valueType is Text, Number, Date, Checkbox, Time or ComboBox.
Use Number for budgets, sizes and durations. Use Time only for a clock time.
ComboBox needs 3 to 5 options in ${languageName(request.language)}. Every other type has an empty options array.
Labels and help texts are in ${languageName(request.language)} and short enough for a form.
Names must be short enough for a dropdown.
For roughly half of the task types, and at least one, define statuses as that type's own kanban workflow.
The other task types get an empty statuses array and keep the instance default columns.
A workflow has 3 to 5 columns in left-to-right order.
Each column has category Todo, InProgress or Done.
Include at least one Todo column and one Done column.
Name the columns for the stages of that specific work, in ${languageName(request.language)}.
Do not reuse Offen, In Arbeit, Erledigt, To do, In progress or Done.
Two task types must not share the same column names.`,
      },
    ]
  )
  tick("Projekt- und Aufgabentypen")
  const usedFieldKeys = new Set<string>()
  const taskTypes = normalizeStatusWorkflows(
    types.taskTypes.map((type) => ({
      displayName: type.displayName.trim(),
      rationale: type.rationale.trim(),
      fields: normalizeTaskFields(type.fields, usedFieldKeys),
      statuses: type.statuses,
    }))
  )
  const fieldCount = taskTypes.reduce((count, type) => count + type.fields.length, 0)
  const workflowCount = taskTypes.filter((type) => type.statuses.length > 0).length
  const workflowText =
    workflowCount === 1 ? "1 eigenen Status-Ablauf" : `${workflowCount} eigene Status-Abläufe`
  emit({
    type: "log",
    level: "success",
    message: `${types.projectTypes.length} Projekt-Typen, ${taskTypes.length} Aufgaben-Typen, ${fieldCount} Zusatzfelder und ${workflowText} aus der Branche abgeleitet.`,
  })

  const companyRaw = await complete(
    client,
    model,
    z.object({ companies: z.array(companyShape).length(preset.companies) }),
    "companies",
    [
      {
        role: "system",
        content:
          "You create fictional customer and partner companies for a Consolidate demo. Return only the schema. Never use real private persons.",
      },
      {
        role: "user",
        content: `${rules}
Create exactly ${preset.companies} fictional companies that would buy from, partner with, or be served by the company in the profile.
Company names must sound real for that industry and be written in ${languageName(request.language)}.
Addresses are fictional. For German, use German streets, postcodes and cities and country "Deutschland". For English, use English-speaking places and country "Germany" only if the profile is set in Germany, otherwise a matching country.
phone is a fictional phone number, not a published real number.
note explains the business relationship in one sentence.`,
      },
    ]
  )
  tick("Unternehmen")
  const usedEmails = new Set<string>()
  const addressFallback =
    request.language === "de"
      ? { street: "Industriestraße 12", zipCode: "10115", city: "Berlin", country: "Deutschland" }
      : { street: "12 Industrial Road", zipCode: "10115", city: "Berlin", country: "Germany" }
  const companies = companyRaw.companies.slice(0, preset.companies).map((company, index) => ({
    name: company.name.trim() || `Firma ${index + 1}`,
    street: company.street.trim() || addressFallback.street,
    zipCode: company.zipCode.trim() || addressFallback.zipCode,
    city: company.city.trim() || addressFallback.city,
    country: company.country.trim() || addressFallback.country,
    phone: company.phone.trim(),
    email: uniqueCompanyEmail(company.name, usedEmails),
    note: company.note.trim(),
  }))
  emit({
    type: "log",
    level: "success",
    message: `${companies.length} Unternehmen erzeugt.`,
  })

  const contacts: DemoPlan["contacts"] = []
  const companyCatalog = companies
    .map((company, index) => `${index}=${company.name}, ${company.city}`)
    .join("; ")
  for (let offset = 0; offset < preset.contacts; offset += CONTACT_BATCH) {
    const count = Math.min(CONTACT_BATCH, preset.contacts - offset)
    try {
      const batch = await complete(
        client,
        model,
        z.object({ contacts: z.array(externalContactShape).length(count) }),
        "external_contacts",
        [
          {
            role: "system",
            content:
              "You create fictional business contacts at customer companies. Return only the schema. These people are not employees of the ICP company.",
          },
          {
            role: "user",
            content: `${rules}
Create exactly ${count} fictional contacts. This is batch ${offset / CONTACT_BATCH + 1}.
They work at these companies: ${companyCatalog}.
companyIndex is zero-based and must point at one of those companies. Spread contacts across companies.
position and department match the industry and are written in ${languageName(request.language)}.
Use realistic personal names in ${languageName(request.language)}.
phone is a fictional number.`,
          },
        ]
      )
      for (const contact of batch.contacts.slice(0, count)) {
        contacts.push({
          firstName: contact.firstName.trim(),
          lastName: contact.lastName.trim(),
          position: contact.position.trim(),
          department: contact.department.trim(),
          companyIndex: clampIndex(contact.companyIndex, companies.length),
          phone: contact.phone.trim(),
          email: uniqueEmail(contact.firstName, contact.lastName, usedEmails),
        })
      }
      emit({
        type: "log",
        level: "success",
        message: `Kontakte ${contacts.length} von ${preset.contacts} erzeugt.`,
      })
    } catch (error) {
      emit({
        type: "log",
        level: "error",
        message: `Kontaktblock ab ${offset + 1} übersprungen: ${error instanceof Error ? error.message : "Fehler"}`,
      })
    }
    tick("Kontakte")
  }

  const people = await complete(
    client,
    model,
    z.object({
      teams: z.array(teamShape).length(preset.teams),
      employees: z.array(employeeShape).length(preset.employees),
    }),
    "teams_and_people",
    [
    {
      role: "system",
      content: "You create realistic demo master data for Consolidate. Return only the schema.",
    },
    {
      role: "user",
      content: `${rules}
Today is ${today}.
Create exactly ${preset.teams} teams and ${preset.employees} employees.
teamIndex is zero-based and must point at one of the teams.
Spread employees across the teams.
Use realistic personal names and industry job titles in ${languageName(request.language)}.
These are internal employees of the ICP company, not the external customer contacts.
Project types for context: ${types.projectTypes.map((type) => type.displayName).join(", ")}.
Task types for context: ${taskTypes.map((type) => type.displayName).join(", ")}.`,
    },
  ])
  tick("Teams und Mitarbeiter")

  const teams = people.teams.slice(0, preset.teams)
  const employees = people.employees.slice(0, preset.employees).map((employee) => ({
    ...employee,
    teamIndex: clampIndex(employee.teamIndex, teams.length),
    email: uniqueEmail(employee.firstName, employee.lastName, usedEmails),
  }))
  emit({
    type: "log",
    level: "success",
    message: `${teams.length} Teams und ${employees.length} Mitarbeiter erzeugt.`,
  })

  const projectsRaw = await complete(
    client,
    model,
    z.object({ projects: z.array(projectShape).length(preset.projects) }),
    "projects",
    [
    {
      role: "system",
      content: "You create realistic demo projects for Consolidate. Return only the schema.",
    },
    {
      role: "user",
      content: `${rules}
Today is ${today}.
Create exactly ${preset.projects} projects this company would really run.
projectTypeIndex is zero-based into: ${types.projectTypes.map((type, index) => `${index}=${type.displayName}`).join(", ")}.
companyIndex is zero-based into customer companies: ${companyCatalog}.
Prefer a project title that names that customer when the work is done for them.
managerIndex and teamIndex are zero-based into employees and teams.
Employees: ${employees.map((employee, index) => `${index}=${employee.firstName} ${employee.lastName}, ${employee.position}`).join("; ")}.
Teams: ${teams.map((team, index) => `${index}=${team.name}`).join(", ")}.
taskTypeIndex is the only task type whose work and kanban columns this project uses.
Task types: ${taskTypes
  .map((type, index) => {
    const columns = type.statuses.length
      ? type.statuses.map((status) => status.name).join(" → ")
      : "default columns"
    return `${index}=${type.displayName}; columns: ${columns}`
  })
  .join(" | ")}.
Choose the task type whose stages match the project. Give every custom workflow at least one project when enough projects exist.
startDate is on or after ${today} and within 30 days. endDate is 30 to 180 days after startDate. Format YYYY-MM-DD.
Project titles must sound like real engagements, not "Projekt 1".`,
    },
  ])
  tick("Projekte")

  const projects = assignProjectTaskTypes(
    projectsRaw.projects.slice(0, preset.projects).map((project, index) => {
      const startDate = asDate(project.startDate, addDays(today, (index % 20) + 1))
      const endDate = asDate(project.endDate, addDays(startDate, 90))
      return {
        ...project,
        projectTypeIndex: clampIndex(project.projectTypeIndex, types.projectTypes.length),
        companyIndex: clampIndex(project.companyIndex, companies.length),
        managerIndex: clampIndex(project.managerIndex, employees.length),
        teamIndex: clampIndex(project.teamIndex, teams.length),
        taskTypeIndex: clampIndex(project.taskTypeIndex, taskTypes.length),
        startDate,
        endDate: endDate > startDate ? endDate : addDays(startDate, 60),
      }
    }),
    taskTypes
  )
  emit({
    type: "log",
    level: "success",
    message: `${projects.length} Projekte erzeugt.`,
  })

  const tasks: DemoPlan["tasks"] = []
  const projectCatalog = projects
    .map((project, index) => {
      const type = taskTypes[project.taskTypeIndex]
      const columns = type.statuses.length
        ? type.statuses.map((status) => `${status.name} (${status.category})`).join(" → ")
        : "default"
      return `${index}=${project.name} (${project.startDate} bis ${project.endDate}); task type ${project.taskTypeIndex}=${type.displayName}; columns: ${columns}`
    })
    .join("\n")
  for (let offset = 0; offset < preset.tasks; offset += TASK_BATCH) {
    const count = Math.min(TASK_BATCH, preset.tasks - offset)
    try {
      const batch = await complete(
        client,
        model,
        z.object({ tasks: z.array(taskShape).length(count) }),
        "tasks",
        [
        {
          role: "system",
          content: "You create realistic demo tasks for Consolidate. Return only the schema.",
        },
        {
          role: "user",
          content: `${rules}
Create exactly ${count} tasks. This is batch ${offset / TASK_BATCH + 1}, so vary the work and do not repeat the same subject.
Each project uses exactly one task type. Set taskTypeIndex to that project's task type.
Projects:
${projectCatalog}
Task type fields. fieldValues must contain every key of the project's task type:
${taskTypes
  .map(
    (type, index) =>
      `${index}=${type.displayName}; ${type.fields
        .map(
          (field) =>
            `${field.key} (${field.valueType}${field.options.length ? `: ${field.options.join(" | ")}` : ""})`
        )
        .join(", ")}`
  )
  .join("\n")}
Time is a clock time HH:mm between 00:00 and 23:59, not a duration.
Durations, budgets and sizes are Number.
Number values use a dot. Checkbox is true or false. Date is YYYY-MM-DD. ComboBox value is exactly one of its options. Text is a short realistic value.
Assignees: ${employees.map((employee, index) => `${index}=${employee.firstName} ${employee.lastName}`).join("; ")}.
Use only those indexes. Dates must fall inside the chosen project's start and end. Format YYYY-MM-DD.
When the project lists named columns, statusName is exactly one of those names and statusCategory is that column's category.
Spread a project's tasks across its columns, from the first stage to the last.
When the columns say default, statusName is empty and statusCategory is Todo, InProgress or Done.
priority is Highest, High, Medium, Low or Lowest.
Subjects must be concrete work for that project's task type.
When a project has named columns, give it one task per column before adding further tasks of that same type.`,
        },
      ])
      for (const task of batch.tasks.slice(0, count)) {
        const projectIndex = clampIndex(task.projectIndex, projects.length)
        const project = projects[projectIndex]
        const taskType = taskTypes[project.taskTypeIndex]
        const sameType = clampIndex(task.taskTypeIndex, taskTypes.length) === project.taskTypeIndex
        const startDate = asDate(task.startDate, project.startDate)
        const dueDate = asDate(task.dueDate, project.endDate)
        const safeDueDate = dueDate < startDate ? project.endDate : dueDate
        const status = resolveTaskStatus(taskType.statuses, sameType ? task.statusName : "", task.statusCategory)
        tasks.push({
          subject: task.subject,
          description: task.description,
          projectIndex,
          taskTypeIndex: project.taskTypeIndex,
          assigneeIndex: clampIndex(task.assigneeIndex, employees.length),
          statusCategory: status.category,
          statusName: status.name,
          priority: task.priority,
          startDate: startDate < project.startDate ? project.startDate : startDate,
          dueDate: safeDueDate,
          fieldValues: taskType.fields.map((field, fieldIndex) => ({
            key: field.key,
            value: storedFieldValue(
              field,
              sameType ? (task.fieldValues.find((entry) => entry.key === field.key)?.value ?? "") : "",
              safeDueDate,
              request.language,
              fieldIndex
            ),
          })),
        })
      }
      emit({
        type: "log",
        level: "success",
        message: `Aufgaben ${Math.min(offset + count, tasks.length)} von ${preset.tasks} erzeugt.`,
      })
    } catch (error) {
      emit({
        type: "log",
        level: "error",
        message: `Aufgabenblock ab ${offset + 1} übersprungen: ${error instanceof Error ? error.message : "Fehler"}`,
      })
    }
    tick("Aufgaben")
  }
  applyWorkflowQuotas(tasks, projects, taskTypes)
  assignTaskFiles(tasks)

  let appointments: DemoPlan["appointments"] = []
  try {
    const appointmentRaw = await complete(
      client,
      model,
      z.object({
        appointments: z.array(appointmentShape).length(preset.appointments),
      }),
      "appointments",
      [
        {
          role: "system",
          content: "You create realistic demo calendar events for Consolidate. Return only the schema.",
        },
        {
          role: "user",
          content: `${rules}
Today is ${today}.
Create exactly ${preset.appointments} appointments: kickoffs, milestone reviews, customer meetings or site visits that fit this industry.
Projects: ${projectCatalog}.
Attendees are zero-based employee indexes: ${employees.map((employee, index) => `${index}=${employee.firstName} ${employee.lastName}`).join("; ")}.
startDate is a weekday within the next 21 days. startTime and endTime are HH:mm between 08:00 and 17:00. The meeting lasts 30 to 90 minutes.
location is a realistic room, plant or customer site in ${languageName(request.language)}.`,
        },
      ]
    )
    appointments = appointmentRaw.appointments.slice(0, preset.appointments).map((appointment, index) => {
      const startDate = asDate(appointment.startDate, addDays(today, (index % 14) + 1))
      const startTime = asTime(appointment.startTime, "09:00:00")
      let endTime = asTime(appointment.endTime, "10:00:00")
      if (endTime <= startTime) endTime = "10:00:00"
      return {
        ...appointment,
        projectIndex: clampIndex(appointment.projectIndex, projects.length),
        startDate,
        startTime,
        endTime,
        attendeeIndexes: (appointment.attendeeIndexes.length
          ? appointment.attendeeIndexes
          : [0]
        ).map((attendee) => clampIndex(attendee, employees.length)),
      }
    })
    emit({
      type: "log",
      level: "success",
      message: `${appointments.length} Termine erzeugt.`,
    })
  } catch (error) {
    emit({
      type: "log",
      level: "error",
      message: `Termine konnten nicht erzeugt werden: ${error instanceof Error ? error.message : "Fehler"}`,
    })
  }
  tick("Termine")

  if (companies.length === 0 || teams.length === 0 || employees.length === 0 || projects.length === 0) {
    throw new Error("Die Vorschau enthält keine Unternehmen, Teams, Mitarbeiter oder Projekte.")
  }

  return {
    language: request.language,
    profile: request.profile,
    presetId: request.presetId,
    projectTypes: types.projectTypes,
    taskTypes,
    companies,
    contacts,
    teams,
    employees,
    projects,
    tasks,
    appointments,
  }
}

function resolveTaskStatus(
  statuses: { name: string; category: DemoPlan["tasks"][number]["statusCategory"] }[],
  requestedName: string,
  fallback: DemoPlan["tasks"][number]["statusCategory"]
) {
  if (statuses.length === 0) return { name: "", category: fallback }
  const match = statuses.find(
    (status) => status.name.toLowerCase() === requestedName.trim().toLowerCase()
  )
  return match ?? statuses[0]
}

function applyWorkflowQuotas(
  tasks: DemoPlan["tasks"],
  projects: DemoPlan["projects"],
  taskTypes: DemoPlan["taskTypes"]
) {
  taskTypes.forEach((taskType, typeIndex) => {
    if (taskType.statuses.length === 0) return
    const projectIndexes = projects.flatMap((project, index) =>
      project.taskTypeIndex === typeIndex ? [index] : []
    )
    const taskIndexes = tasks.flatMap((task, index) =>
      task.taskTypeIndex === typeIndex ? [index] : []
    )
    if (projectIndexes.length === 0 || taskIndexes.length === 0) return
    const primary = projectIndexes[0]
    taskIndexes.forEach((taskIndex, position) => {
      const projectIndex =
        position < taskType.statuses.length
          ? primary
          : projectIndexes[position % projectIndexes.length]
      const project = projects[projectIndex]
      const task = tasks[taskIndex]
      task.projectIndex = projectIndex
      if (task.startDate < project.startDate) task.startDate = project.startDate
      if (task.dueDate < task.startDate || task.dueDate > project.endDate) task.dueDate = project.endDate
      const status = taskType.statuses[position % taskType.statuses.length]
      task.statusName = status.name
      task.statusCategory = status.category
    })
  })
}
