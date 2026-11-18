import { DEMO_PASSWORD, type DemoPlan } from "@/lib/demo-plan"
import { buildTaskDocument } from "@/lib/demo-files"
import {
  attachTaskFile,
  associateRecords,
  createCalendar,
  createCalendarEvent,
  createCompanyRecord,
  createContact,
  createDataType,
  createEmployee,
  createProject,
  createTaskRecord,
  createTaskStatus,
  createTeam,
  errorText,
  loadImportContext,
  loadTaskInputFieldNames,
  loadTypeEnums,
  matchEnumValue,
  type DataFormInfo,
  type ImportContext,
} from "@/lib/consolidate"
import type { ConsolidateSession } from "@/lib/session"
import type { ImportSummary, StreamEvent } from "@/lib/stream-events"
import { toGraphqlFieldValue, type TaskFieldDefinition } from "@/lib/task-fields"

type CreatedType = { key: string; displayName: string; enumName: string | null }
type CreatedPerson = { id: string; teamIndex: number }

function findForm(forms: DataFormInfo[], kind: "project" | "task"): DataFormInfo | undefined {
  const tokens =
    kind === "project"
      ? ["project", "projekt", "projekte"]
      : ["task", "tasks", "aufgabe", "aufgaben"]
  const active = forms.filter((form) => !form.archived)
  return (
    active.find((form) => tokens.includes(form.dataCollection.toLowerCase())) ??
    active.find((form) => tokens.includes(form.displayName.toLowerCase()))
  )
}

function existingType(form: DataFormInfo | undefined, displayName: string) {
  return form?.types.find(
    (type) =>
      !type.archived && type.displayName.localeCompare(displayName, undefined, { sensitivity: "accent" }) === 0
  )
}

export async function importDemoPlan(
  session: ConsolidateSession,
  plan: DemoPlan,
  emit: (event: StreamEvent) => void
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    projectTypes: 0,
    taskTypes: 0,
    teams: 0,
    employees: 0,
    companies: 0,
    contacts: 0,
    projects: 0,
    tasks: 0,
    appointments: 0,
    failed: 0,
    appUrl: session.appUrl,
    demoPassword: DEMO_PASSWORD,
  }

  const total =
    plan.projectTypes.length +
    plan.taskTypes.length +
    plan.teams.length +
    plan.employees.length +
    plan.companies.length +
    plan.contacts.length +
    plan.projects.length +
    plan.tasks.length +
    plan.appointments.length
  let completed = 0
  const tick = (label: string) => {
    completed += 1
    emit({ type: "progress", completed, total, label })
  }

  emit({ type: "log", level: "info", message: "Lade Rollen, Status, Formulare und Kalender." })
  const context = await loadImportContext(session)
  const projectForm = findForm(context.dataForms, "project")
  const taskForm = findForm(context.dataForms, "task")
  if (!projectForm || !taskForm) {
    throw new Error(
      `Projekt- oder Aufgabenformular wurde nicht gefunden. Vorhandene Sammlungen: ${context.dataForms
        .map((form) => form.dataCollection)
        .join(", ")}`
    )
  }
  emit({
    type: "log",
    level: "info",
    message: `Formulare: Projekte „${projectForm.dataCollection}“, Aufgaben „${taskForm.dataCollection}“.`,
  })

  const projectTypes: CreatedType[] = []
  for (const [index, type] of plan.projectTypes.entries()) {
    projectTypes.push(
      await ensureType(session, context, projectForm, type.displayName, index, "Projekt-Typ", summary, emit)
    )
    summary.projectTypes = projectTypes.filter((type) => type.key).length
    tick("Projekt-Typen")
  }

  const taskTypes: CreatedType[] = []
  for (const [index, type] of plan.taskTypes.entries()) {
    taskTypes.push(
      await ensureType(
        session,
        context,
        taskForm,
        type.displayName,
        index,
        "Aufgaben-Typ",
        summary,
        emit,
        type.fields
      )
    )
    summary.taskTypes = taskTypes.filter((type) => type.key).length
    tick("Aufgaben-Typen")
  }

  await resolveEnums(session, projectTypes, taskTypes, emit)
  const taskInputFields = await waitForTaskFields(session, plan, emit)

  const companyIds: string[] = []
  for (const company of plan.companies) {
    try {
      const created = await createCompanyRecord(session, company)
      companyIds.push(created.id)
      summary.companies += 1
      emit({
        type: "log",
        level: "success",
        message: `Unternehmen „${created.displayName}“ angelegt (ID: ${created.id}).`,
      })
    } catch (error) {
      companyIds.push("")
      summary.failed += 1
      emit({
        type: "log",
        level: "error",
        message: `Unternehmen „${company.name}“ fehlgeschlagen: ${errorText(error)}`,
      })
    }
    tick("Unternehmen")
  }

  for (const contact of plan.contacts) {
    const companyId = companyIds[contact.companyIndex]
    const companyName = plan.companies[contact.companyIndex]?.name
    try {
      const created = await createContact(session, {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        position: contact.position,
        phone: contact.phone,
        department: contact.department,
        companyId: companyId || undefined,
      })
      summary.contacts += 1
      emit({
        type: "log",
        level: "success",
        message: companyName
          ? `Kontakt „${created.displayName}“ bei „${companyName}“ angelegt (ID: ${created.id}).`
          : `Kontakt „${created.displayName}“ angelegt (ID: ${created.id}).`,
      })
    } catch (error) {
      summary.failed += 1
      emit({
        type: "log",
        level: "error",
        message: `Kontakt „${contact.firstName} ${contact.lastName}“ fehlgeschlagen: ${errorText(error)}`,
      })
    }
    tick("Kontakte")
  }

  const defaultRole =
    context.roles.find((role) => role.isDefault && !role.isSystemRole) ??
    context.roles.find((role) => role.isDefault) ??
    context.roles.find((role) => !role.isSystemRole)

  const teamIds: string[] = []
  for (const team of plan.teams) {
    try {
      const created = await createTeam(session, team.name, defaultRole?.id)
      teamIds.push(created.id)
      summary.teams += 1
      emit({
        type: "log",
        level: "success",
        message: `Team „${created.name}“ angelegt (ID: ${created.id}).`,
      })
    } catch (error) {
      teamIds.push("")
      summary.failed += 1
      emit({
        type: "log",
        level: "error",
        message: `Team „${team.name}“ fehlgeschlagen: ${errorText(error)}`,
      })
    }
    tick("Teams")
  }

  const people: CreatedPerson[] = []
  for (const employee of plan.employees) {
    const teamId = teamIds[employee.teamIndex] || teamIds.find(Boolean) || ""
    const roleIds = [defaultRole?.id, teamId].filter((id): id is string => Boolean(id))
    try {
      if (roleIds.length === 0) throw new Error("Keine Rolle für neue Mitarbeiter vorhanden.")
      let contactId: string | undefined
      try {
        const contact = await createContact(session, employee)
        contactId = contact.id
      } catch (error) {
        emit({
          type: "log",
          level: "error",
          message: `Kontakt ${employee.firstName} ${employee.lastName} fehlgeschlagen, Benutzer wird ohne Kontakt angelegt: ${errorText(error)}`,
        })
      }
      const user = await createEmployee(session, {
        email: employee.email,
        password: DEMO_PASSWORD,
        contactId,
        roleIds: Array.from(new Set(roleIds)),
      })
      people.push({ id: user.id, teamIndex: employee.teamIndex })
      summary.employees += 1
      emit({
        type: "log",
        level: "success",
        message: `Mitarbeiter „${employee.firstName} ${employee.lastName}“ angelegt (ID: ${user.id}).`,
      })
    } catch (error) {
      people.push({ id: "", teamIndex: employee.teamIndex })
      summary.failed += 1
      emit({
        type: "log",
        level: "error",
        message: `Mitarbeiter „${employee.firstName} ${employee.lastName}“ fehlgeschlagen: ${errorText(error)}`,
      })
    }
    tick("Mitarbeiter")
  }

  const { statuses, columnsByType } = await ensureStatuses(session, context, plan, taskTypes, emit)
  const projectIds: string[] = []
  for (const project of plan.projects) {
    const manager = people[project.managerIndex]
    const teamId = teamIds[project.teamIndex]
    try {
      const created = await createProject(session, {
        name: project.name,
        summary: project.summary,
        startDate: project.startDate,
        endDate: project.endDate,
        projectManagerId: manager?.id || undefined,
        responsibleId: teamId || manager?.id || undefined,
        typeName: projectTypes[project.projectTypeIndex]?.enumName ?? undefined,
      })
      projectIds.push(created.id)
      summary.projects += 1
      emit({
        type: "log",
        level: created.linkedType ? "success" : "error",
        message: created.linkedType
          ? `Projekt „${created.displayName}“ angelegt (ID: ${created.id}).`
          : `Projekt „${created.displayName}“ angelegt (ID: ${created.id}), ohne Projekt-Typ.`,
      })
      const companyId = companyIds[project.companyIndex]
      const companyName = plan.companies[project.companyIndex]?.name
      if (companyId) {
        try {
          await associateRecords(session, created.id, companyId)
          emit({
            type: "log",
            level: "success",
            message: `Projekt „${created.displayName}“ mit „${companyName}“ verknüpft.`,
          })
        } catch (error) {
          emit({
            type: "log",
            level: "error",
            message: `Verknüpfung von „${created.displayName}“ mit „${companyName}“ fehlgeschlagen: ${errorText(error)}`,
          })
        }
      }
    } catch (error) {
      projectIds.push("")
      summary.failed += 1
      emit({
        type: "log",
        level: "error",
        message: `Projekt „${project.name}“ fehlgeschlagen: ${errorText(error)}`,
      })
    }
    tick("Projekte")
  }

  for (const task of plan.tasks) {
    const projectId = projectIds[task.projectIndex]
    const assignee = people[task.assigneeIndex]
    const typeKey = taskTypes[task.taskTypeIndex]?.key
    const status = pickStatus(statuses, task, typeKey, columnsByType.get(task.taskTypeIndex))
    try {
      if (!status) throw new Error("Kein Aufgabenstatus vorhanden.")
      const created = await createTaskRecord(session, {
        subject: task.subject,
        description: task.description,
        statusId: status.id,
        priority: task.priority,
        projectId: projectId || undefined,
        responsibleId: assignee?.id || undefined,
        startDate: task.startDate,
        dueDate: task.dueDate,
        typeName: taskTypes[task.taskTypeIndex]?.enumName ?? undefined,
        extraFields: taskFieldValues(plan, task, taskInputFields),
      })
      summary.tasks += 1
      const fieldNote = created.fieldsApplied
        ? " Zusatzfelder gesetzt."
        : task.fieldValues.length > 0
          ? " Zusatzfelder nicht übernommen."
          : ""
      emit({
        type: "log",
        level: created.linkedType && (created.fieldsApplied || task.fieldValues.length === 0) ? "success" : "error",
        message: created.linkedType
          ? `Aufgabe „${created.displayName}“ im Status „${status.name}“ angelegt (ID: ${created.id}).${fieldNote}`
          : `Aufgabe „${created.displayName}“ im Status „${status.name}“ angelegt (ID: ${created.id}), ohne Aufgaben-Typ.${fieldNote}`,
      })
      if (task.file) {
        try {
          const versions = Array.from({ length: task.file.versions }, (_, index) =>
            buildTaskDocument({
              kind: task.file!.kind,
              title: task.subject,
              description: task.description,
              version: index + 1,
              versions: task.file!.versions,
              language: plan.language,
            })
          )
          const attached = await attachTaskFile(session, {
            taskId: created.id,
            changeVector: created.changeVector,
            fileName: task.file.name,
            contentType: versions[0].contentType,
            versions: versions.map((version) => version.body),
          })
          emit({
            type: "log",
            level: "success",
            message:
              attached.versionCount > 1
                ? `Datei „${task.file.name}“ mit ${attached.versionCount} Versionen an „${created.displayName}“ angehängt.`
                : `Datei „${task.file.name}“ an „${created.displayName}“ angehängt.`,
          })
        } catch (error) {
          emit({
            type: "log",
            level: "error",
            message: `Datei „${task.file.name}“ für „${created.displayName}“ fehlgeschlagen: ${errorText(error)}`,
          })
        }
      }
    } catch (error) {
      summary.failed += 1
      emit({
        type: "log",
        level: "error",
        message: `Aufgabe „${task.subject}“ fehlgeschlagen: ${errorText(error)}`,
      })
    }
    tick("Aufgaben")
  }

  const calendarId = await resolveCalendar(session, context, plan.language, emit)
  for (const appointment of plan.appointments) {
    const projectId = projectIds[appointment.projectIndex]
    const projectName = plan.projects[appointment.projectIndex]?.name
    const attendeeIds = Array.from(
      new Set(
        appointment.attendeeIndexes
          .map((index) => people[index]?.id)
          .filter((id): id is string => Boolean(id))
      )
    )
    try {
      if (!calendarId) throw new Error("Kein Kalender vorhanden.")
      const created = await createCalendarEvent(session, {
        calendarId,
        title: appointment.title,
        location: appointment.location,
        description: projectName ? `${appointment.title} · ${projectName}` : appointment.title,
        startDate: appointment.startDate,
        startTime: appointment.startTime,
        endDate: appointment.startDate,
        endTime: appointment.endTime,
        attendeeIds,
      })
      summary.appointments += 1
      emit({
        type: "log",
        level: "success",
        message: `Termin „${created.title}“ angelegt (ID: ${created.id}).`,
      })
      if (created.appointmentId && projectId) {
        try {
          await associateRecords(session, created.appointmentId, projectId)
          emit({
            type: "log",
            level: "success",
            message: `Termin „${created.title}“ mit Projekt „${projectName}“ verknüpft.`,
          })
        } catch (error) {
          emit({
            type: "log",
            level: "error",
            message: `Verknüpfung für „${created.title}“ fehlgeschlagen: ${errorText(error)}`,
          })
        }
      }
    } catch (error) {
      summary.failed += 1
      emit({
        type: "log",
        level: "error",
        message: `Termin „${appointment.title}“ fehlgeschlagen: ${errorText(error)}`,
      })
    }
    tick("Termine")
  }

  emit({
    type: "log",
    level: summary.failed ? "error" : "success",
    message: summary.failed
      ? `Import beendet. ${summary.failed} Schritte sind fehlgeschlagen.`
      : "Import beendet.",
  })
  return summary
}

async function ensureType(
  session: ConsolidateSession,
  context: ImportContext,
  form: DataFormInfo,
  displayName: string,
  colorIndex: number,
  label: string,
  summary: ImportSummary,
  emit: (event: StreamEvent) => void,
  fields?: TaskFieldDefinition[]
): Promise<CreatedType> {
  const found = existingType(form, displayName)
  if (found) {
    emit({
      type: "log",
      level: "info",
      message: `${label} „${displayName}“ ist bereits vorhanden (ID: ${found.key}).`,
    })
    return { key: found.key, displayName, enumName: null }
  }
  try {
    let created
    let fieldsApplied = Boolean(fields?.length)
    try {
      created = await createDataType(session, {
        dataCollection: form.dataCollection,
        displayName,
        colorIndex,
        fields,
      })
    } catch (error) {
      if (!fields?.length) throw error
      fieldsApplied = false
      emit({
        type: "log",
        level: "error",
        message: `${label} „${displayName}“: Zusatzfelder nicht angelegt (${errorText(error)}). Der Typ wird ohne Felder angelegt.`,
      })
      created = await createDataType(session, {
        dataCollection: form.dataCollection,
        displayName,
        colorIndex,
      })
    }
    form.types.push({ key: created.key, displayName: created.displayName, archived: false })
    const fieldNames = fieldsApplied ? fields?.map((field) => field.label).join(", ") : ""
    emit({
      type: "log",
      level: "success",
      message: fieldNames
        ? `${label} „${created.displayName}“ angelegt mit Feldern ${fieldNames} (ID: ${created.key}).`
        : `${label} „${created.displayName}“ angelegt (ID: ${created.key}).`,
    })
    return { key: created.key, displayName: created.displayName, enumName: null }
  } catch (error) {
    summary.failed += 1
    emit({
      type: "log",
      level: "error",
      message: `${label} „${displayName}“ fehlgeschlagen: ${errorText(error)}`,
    })
    return { key: "", displayName, enumName: null }
  }
}

async function waitForTaskFields(
  session: ConsolidateSession,
  plan: DemoPlan,
  emit: (event: StreamEvent) => void
): Promise<Set<string>> {
  const expected = plan.taskTypes.flatMap((type) => type.fields.map((field) => field.key))
  let available = new Set<string>()
  if (expected.length === 0) return available
  for (let attempt = 0; attempt < 4; attempt += 1) {
    available = await loadTaskInputFieldNames(session)
    if (expected.every((key) => available.has(key))) {
      emit({
        type: "log",
        level: "success",
        message: "Zusatzfelder der Aufgaben-Typen sind im Schema verfügbar.",
      })
      return available
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  const missing = plan.taskTypes
    .flatMap((type) => type.fields)
    .filter((field) => !available.has(field.key))
    .map((field) => field.label)
  emit({
    type: "log",
    level: "error",
    message: `Einige Zusatzfelder sind im Schema noch nicht sichtbar: ${missing.join(", ")}.`,
  })
  return available
}

function taskFieldValues(
  plan: DemoPlan,
  task: DemoPlan["tasks"][number],
  available: Set<string>
): Record<string, string | number | boolean> {
  const definitions = plan.taskTypes[task.taskTypeIndex]?.fields ?? []
  const values: Record<string, string | number | boolean> = {}
  for (const entry of task.fieldValues) {
    const field = definitions.find((definition) => definition.key === entry.key)
    if (!field || !available.has(field.key)) continue
    const value = toGraphqlFieldValue(field, entry.value)
    if (value !== undefined) values[field.key] = value
  }
  return values
}

async function resolveEnums(
  session: ConsolidateSession,
  projectTypes: CreatedType[],
  taskTypes: CreatedType[],
  emit: (event: StreamEvent) => void
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const enums = await loadTypeEnums(session)
    let pending = 0
    for (const type of projectTypes) {
      if (!type.key || type.enumName) continue
      type.enumName = matchEnumValue(enums.projectTypes, type.key, type.displayName)
      if (!type.enumName) pending += 1
    }
    for (const type of taskTypes) {
      if (!type.key || type.enumName) continue
      type.enumName = matchEnumValue(enums.taskTypes, type.key, type.displayName)
      if (!type.enumName) pending += 1
    }
    if (pending === 0) {
      emit({ type: "log", level: "success", message: "Neue Typen sind im GraphQL-Schema verfügbar." })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  emit({
    type: "log",
    level: "error",
    message: "Einige neue Typen sind im Schema noch nicht als Enum sichtbar. Zugehörige Datensätze werden ohne Typ angelegt.",
  })
}

async function ensureStatuses(
  session: ConsolidateSession,
  context: ImportContext,
  plan: DemoPlan,
  taskTypes: CreatedType[],
  emit: (event: StreamEvent) => void
): Promise<{
  statuses: ImportContext["taskStatuses"]
  columnsByType: Map<number, ImportContext["taskStatuses"]>
}> {
  const statuses = [...context.taskStatuses]
  const columnsByType = new Map<number, ImportContext["taskStatuses"]>()
  for (const [index, type] of plan.taskTypes.entries()) {
    const key = taskTypes[index]?.key
    if (!key || type.statuses.length === 0) continue
    let afterStatusId: string | undefined
    const columns: ImportContext["taskStatuses"] = []
    for (const planned of type.statuses) {
      const created = await createPlannedStatus(session, planned, key, type.displayName, afterStatusId, emit)
      if (!created) continue
      afterStatusId = created.id
      const record = { ...created, availableInTypes: [key] }
      statuses.push(record)
      columns.push(record)
    }
    columnsByType.set(index, columns)
    if (columns.length > 0) {
      emit({
        type: "log",
        level: "success",
        message: `Kanban für „${type.displayName}“: ${columns.map((column) => column.name).join(" → ")}.`,
      })
    }
  }

  const sharedKeys = taskTypes
    .filter((type, index) => type.key && plan.taskTypes[index]?.statuses.length === 0)
    .map((type) => type.key)
  const sharedCovered = sharedKeys.every((key) =>
    statuses.some(
      (status) => status.availableInTypes.length === 0 || status.availableInTypes.includes(key)
    )
  )
  if (!sharedCovered && sharedKeys.length > 0) {
    const names =
      plan.language === "de"
        ? [
            ["Offen", "Todo"],
            ["In Arbeit", "InProgress"],
            ["Erledigt", "Done"],
          ]
        : [
            ["To do", "Todo"],
            ["In progress", "InProgress"],
            ["Done", "Done"],
          ]
    let afterStatusId: string | undefined
    for (const [name, category] of names) {
      try {
        const status = await createTaskStatus(session, {
          name,
          category: category as "Todo" | "InProgress" | "Done",
          availableInTypes: sharedKeys,
          afterStatusId,
        })
        afterStatusId = status.id
        statuses.push({ ...status, availableInTypes: sharedKeys })
        emit({ type: "log", level: "success", message: `Status „${status.name}“ angelegt (ID: ${status.id}).` })
      } catch (error) {
        emit({
          type: "log",
          level: "error",
          message: `Status „${name}“ fehlgeschlagen: ${errorText(error)}`,
        })
      }
    }
  }
  return { statuses, columnsByType }
}

async function createPlannedStatus(
  session: ConsolidateSession,
  planned: DemoPlan["taskTypes"][number]["statuses"][number],
  typeKey: string,
  typeName: string,
  afterStatusId: string | undefined,
  emit: (event: StreamEvent) => void
): Promise<{ id: string; name: string; category: "Todo" | "InProgress" | "Done" } | null> {
  const attempts = [
    { name: planned.name, afterStatusId },
    { name: planned.name, afterStatusId: undefined },
    { name: `${planned.name} · ${typeName}`.slice(0, 40), afterStatusId: undefined },
  ]
  let lastError = "unbekannter Fehler"
  for (const attempt of attempts) {
    try {
      return await createTaskStatus(session, {
        name: attempt.name,
        category: planned.category,
        availableInTypes: [typeKey],
        afterStatusId: attempt.afterStatusId,
      })
    } catch (error) {
      lastError = errorText(error)
    }
  }
  emit({
    type: "log",
    level: "error",
    message: `Status „${planned.name}“ für „${typeName}“ fehlgeschlagen: ${lastError}`,
  })
  return null
}

function pickStatus(
  statuses: ImportContext["taskStatuses"],
  task: DemoPlan["tasks"][number],
  typeKey?: string,
  typeColumns?: ImportContext["taskStatuses"]
): ImportContext["taskStatuses"][number] | undefined {
  if (typeColumns && typeColumns.length > 0) {
    const named = typeColumns.find(
      (status) => status.name.toLowerCase() === task.statusName.toLowerCase()
    )
    if (named) return named
    const sameCategory = typeColumns.filter((status) => status.category === task.statusCategory)
    return sameCategory[0] ?? typeColumns[0]
  }
  const pool = statuses.filter((status) => status.category === task.statusCategory)
  const allowed = pool.filter(
    (status) =>
      status.availableInTypes.length === 0 ||
      (typeKey ? status.availableInTypes.includes(typeKey) : false)
  )
  return allowed[0] ?? pool[0] ?? statuses[0]
}

async function resolveCalendar(
  session: ConsolidateSession,
  context: ImportContext,
  language: DemoPlan["language"],
  emit: (event: StreamEvent) => void
): Promise<string | null> {
  const ownDefault = context.calendars.find(
    (calendar) => calendar.isDefaultCalendar && calendar.owner.id === context.me.user.id
  )
  const own = context.calendars.find((calendar) => calendar.owner.id === context.me.user.id)
  const calendar = ownDefault ?? own
  if (calendar) return calendar.id
  try {
    const created = await createCalendar(
      session,
      language === "de" ? "Demokalender" : "Demo calendar"
    )
    emit({
      type: "log",
      level: "success",
      message: `Kalender „${created.name}“ angelegt (ID: ${created.id}).`,
    })
    return created.id
  } catch (error) {
    emit({
      type: "log",
      level: "error",
      message: `Kalender fehlgeschlagen: ${errorText(error)}`,
    })
    return null
  }
}
