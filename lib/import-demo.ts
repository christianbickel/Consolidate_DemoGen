import { fetchCompanyLogo } from "@/lib/company-logo"
import { createAvatarDeck, type AvatarPicture } from "@/lib/contact-avatar"
import { DEMO_PASSWORD, type DemoPlan, type PersonGender } from "@/lib/demo-plan"
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
  loadDynamicSchema,
  loadSalutationOptions,
  matchEnumValue,
  securityRulesForNewEntry,
  shareCalendarWithUsers,
  withReaderRoles,
  type DataFormInfo,
  type ImportContext,
  type SecurityRuleInput,
} from "@/lib/consolidate"
import type { ConsolidateSession } from "@/lib/session"
import { genderAdjective, genderLabel, inferPersonGender, matchSalutationId } from "@/lib/person-gender"
import type { ImportSummary, StreamEvent } from "@/lib/stream-events"
import { toGraphqlFieldValue, type TaskFieldDefinition } from "@/lib/task-fields"

type CreatedType = { key: string; displayName: string; enumName: string | null }
type CreatedPerson = { id: string; teamIndex: number }

type PickedAvatar = AvatarPicture & { note: string }

function assignAvatars(
  people: { key: string; name: string; gender: PersonGender }[],
  emit: (event: StreamEvent) => void
): Map<string, PickedAvatar> {
  const assigned = new Map<string, PickedAvatar>()
  try {
    const deck = createAvatarDeck()
    for (const person of people) {
      const picture = deck.take(person.gender)
      if (picture) assigned.set(person.key, { ...picture, note: "" })
    }
    for (const person of people) {
      if (assigned.has(person.key) || person.gender === "neutral") continue
      const picture = deck.take("neutral")
      if (!picture) break
      assigned.set(person.key, {
        ...picture,
        note: ` Ersatzbild (neutral), weil kein weiteres ${genderAdjective(person.gender)} Bild frei war.`,
      })
    }
  } catch (error) {
    emit({
      type: "log",
      level: "error",
      message: `Avatarbilder nicht geladen: ${errorText(error)}`,
    })
    return assigned
  }
  for (const person of people) {
    if (assigned.has(person.key)) continue
    emit({
      type: "log",
      level: "error",
      message: `Kein weiteres Avatarbild für „${person.name}“ (${genderLabel(person.gender)}).`,
    })
  }
  return assigned
}

function avatarSentence(avatar: PickedAvatar | undefined, hasAvatar: boolean): string {
  if (!avatar) return ""
  return hasAvatar ? ` Avatar gesetzt.${avatar.note}` : " Avatar nicht übernommen."
}

async function loadLogo(
  name: string,
  index: number,
  emit: (event: StreamEvent) => void
): Promise<Buffer | undefined> {
  try {
    return await fetchCompanyLogo(index)
  } catch (error) {
    emit({
      type: "log",
      level: "error",
      message: `Firmenlogo für „${name}“ nicht geladen: ${errorText(error)}`,
    })
    return undefined
  }
}

function findCollection(forms: DataFormInfo[], tokens: string[]): string | undefined {
  const active = forms.filter((form) => !form.archived)
  return (
    active.find((form) => tokens.includes(form.dataCollection.toLowerCase())) ??
    active.find((form) => tokens.includes(form.displayName.toLowerCase()))
  )?.dataCollection
}

async function readerSecurity(
  session: ConsolidateSession,
  dataCollection: string | undefined,
  adminUserId: string,
  roleIds: string[],
  emit: (event: StreamEvent) => void,
  label: string
): Promise<SecurityRuleInput[] | undefined> {
  try {
    const rules = dataCollection
      ? await securityRulesForNewEntry(session, dataCollection, adminUserId)
      : [{ key: { userId: adminUserId }, value: "Manage" }]
    return withReaderRoles(rules, roleIds)
  } catch (error) {
    emit({
      type: "log",
      level: "error",
      message: `${label}-Rechte konnten nicht gelesen werden. Die Datensätze werden mit Leserecht der Demo-Rollen angelegt: ${errorText(error)}`,
    })
    return withReaderRoles([{ key: { userId: adminUserId }, value: "Manage" }], roleIds)
  }
}

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

  let taskInputFields = await reloadCreatedSchema(
    session,
    plan,
    projectTypes,
    taskTypes,
    emit,
    "Schema wird neu geladen."
  )

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

  const readerRoleIds = Array.from(
    new Set([defaultRole?.id, ...teamIds].filter((id): id is string => Boolean(id)))
  )
  if (readerRoleIds.length > 0) {
    emit({
      type: "log",
      level: "info",
      message:
        "Demo-Benutzer erhalten über ihre Rolle und ihre Teams mindestens Leserecht auf alle angelegten Demodaten.",
    })
  }

  const contactCollection = findCollection(context.dataForms, ["contact", "contacts", "kontakt", "kontakte"])
  const companySecurity = await readerSecurity(
    session,
    findCollection(context.dataForms, ["company", "companies", "unternehmen", "firma"]),
    context.me.user.id,
    readerRoleIds,
    emit,
    "Unternehmen"
  )
  const contactSecurity = await readerSecurity(
    session,
    contactCollection,
    context.me.user.id,
    readerRoleIds,
    emit,
    "Kontakt"
  )
  const projectSecurity = await readerSecurity(
    session,
    projectForm.dataCollection,
    context.me.user.id,
    readerRoleIds,
    emit,
    "Projekt"
  )
  const taskSecurity = await readerSecurity(
    session,
    taskForm.dataCollection,
    context.me.user.id,
    readerRoleIds,
    emit,
    "Aufgaben"
  )
  const companyIds: string[] = []
  const contactsByCompany = plan.companies.map(() => [] as { id: string; name: string }[])
  for (const [companyIndex, company] of plan.companies.entries()) {
    try {
      const logo = await loadLogo(company.name, companyIndex, emit)
      const created = await createCompanyRecord(session, { ...company, logo, securityRules: companySecurity })
      companyIds.push(created.id)
      summary.companies += 1
      emit({
        type: "log",
        level: logo && !created.hasLogo ? "error" : "success",
        message: `Unternehmen „${created.displayName}“ angelegt (ID: ${created.id}).${
          logo ? (created.hasLogo ? " Logo gesetzt." : " Logo nicht übernommen.") : ""
        }`,
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

  let salutationOptions: { id: number; value: string }[] = []
  if (contactCollection) {
    try {
      salutationOptions = await loadSalutationOptions(session, contactCollection)
    } catch (error) {
      emit({
        type: "log",
        level: "error",
        message: `Anreden konnten nicht gelesen werden, Kontakte werden ohne Anrede angelegt: ${errorText(error)}`,
      })
    }
  }
  const salutationByGender = new Map<PersonGender, number>()
  for (const gender of ["male", "female", "neutral"] as const) {
    const id = matchSalutationId(salutationOptions, gender)
    if (typeof id === "number") salutationByGender.set(gender, id)
  }
  const avatars = assignAvatars(
    [
      ...plan.contacts.map((contact, index) => ({
        key: `contact:${index}`,
        name: `${contact.firstName} ${contact.lastName}`,
        gender: contact.gender ?? inferPersonGender(contact.firstName),
      })),
      ...plan.employees.map((employee, index) => ({
        key: `employee:${index}`,
        name: `${employee.firstName} ${employee.lastName}`,
        gender: employee.gender ?? inferPersonGender(employee.firstName),
      })),
    ],
    emit
  )

  for (const [index, contact] of plan.contacts.entries()) {
    const companyId = companyIds[contact.companyIndex]
    const companyName = plan.companies[contact.companyIndex]?.name
    try {
      const gender = contact.gender ?? inferPersonGender(contact.firstName)
      const avatar = avatars.get(`contact:${index}`)
      const created = await createContact(session, {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        position: contact.position,
        phone: contact.phone,
        department: contact.department,
        companyId: companyId || undefined,
        avatar,
        salutation: salutationByGender.get(gender),
        securityRules: contactSecurity,
      })
      summary.contacts += 1
      contactsByCompany[contact.companyIndex]?.push({
        id: created.id,
        name: created.displayName,
      })
      const linked = Boolean(companyId) && created.linkedCompany
      const avatarMissing = Boolean(avatar) && !created.hasAvatar
      emit({
        type: "log",
        level: (companyId && !created.linkedCompany) || avatarMissing ? "error" : "success",
        message:
          (linked
            ? `Kontakt „${created.displayName}“ mit Unternehmen „${companyName}“ verknüpft (ID: ${created.id}).`
            : companyName
              ? `Kontakt „${created.displayName}“ angelegt (ID: ${created.id}), ohne Beziehung zu „${companyName}“.`
              : `Kontakt „${created.displayName}“ angelegt (ID: ${created.id}).`) +
          avatarSentence(avatar, created.hasAvatar),
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

  const people: CreatedPerson[] = []
  let licenseReached = false
  for (const [index, employee] of plan.employees.entries()) {
    const teamId = teamIds[employee.teamIndex] || teamIds.find(Boolean) || ""
    const roleIds = [defaultRole?.id, teamId].filter((id): id is string => Boolean(id))
    try {
      if (licenseReached) {
        people.push({ id: "", teamIndex: employee.teamIndex })
        tick("Mitarbeiter")
        continue
      }
      if (roleIds.length === 0) throw new Error("Keine Rolle für neue Mitarbeiter vorhanden.")
      let contactId: string | undefined
      let avatarFailed = false
      let avatarNote = ""
      try {
        const gender = employee.gender ?? inferPersonGender(employee.firstName)
        const avatar = avatars.get(`employee:${index}`)
        const contact = await createContact(session, {
          ...employee,
          avatar,
          salutation: salutationByGender.get(gender),
          securityRules: contactSecurity,
        })
        contactId = contact.id
        avatarFailed = Boolean(avatar) && !contact.hasAvatar
        avatarNote = avatarSentence(avatar, contact.hasAvatar)
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
        adminUserId: context.me.user.id,
        readerRoleIds,
      })
      people.push({ id: user.id, teamIndex: employee.teamIndex })
      summary.employees += 1
      emit({
        type: "log",
        level: avatarFailed ? "error" : "success",
        message: `Mitarbeiter „${employee.firstName} ${employee.lastName}“ angelegt (ID: ${user.id}). Der verbundene Service-User hat Manage-Recht.${avatarNote}`,
      })
    } catch (error) {
      people.push({ id: "", teamIndex: employee.teamIndex })
      summary.failed += 1
      const message = errorText(error)
      emit({
        type: "log",
        level: "error",
        message: `Mitarbeiter „${employee.firstName} ${employee.lastName}“ fehlgeschlagen: ${message}`,
      })
      if (/license limit/i.test(message)) {
        licenseReached = true
        emit({
          type: "log",
          level: "error",
          message: "Weitere Mitarbeiter werden übersprungen, weil das Lizenzlimit der Instanz erreicht ist.",
        })
      }
    }
    tick("Mitarbeiter")
  }

  const { statuses, columnsByType } = await ensureStatuses(session, context, plan, taskTypes, emit)
  taskInputFields = await reloadCreatedSchema(
    session,
    plan,
    projectTypes,
    taskTypes,
    emit,
    "Schema wird vor den Projekten erneut geprüft."
  )
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
        securityRules: projectSecurity,
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

  taskInputFields = await reloadCreatedSchema(
    session,
    plan,
    projectTypes,
    taskTypes,
    emit,
    "Schema wird vor den Aufgaben erneut geprüft."
  )
  const serviceUser = context.me.user.type === "Service"
  if (serviceUser && plan.tasks.some((task) => task.assignToAdmin)) {
    emit({
      type: "log",
      level: "info",
      message:
        "Der Service-User kann nicht als Verantwortlicher gesetzt werden. Diese Aufgaben bleiben bei den Mitarbeitern.",
    })
  }
  const fallbackStatus = statuses.find((status) => status.availableInTypes.length === 0) ?? statuses[0]

  for (const [taskIndex, task] of plan.tasks.entries()) {
    const projectId = projectIds[task.projectIndex]
    const project = plan.projects[task.projectIndex]
    const companyId = project ? companyIds[project.companyIndex] : ""
    const companyName = project ? plan.companies[project.companyIndex]?.name : ""
    const companyContacts = project ? (contactsByCompany[project.companyIndex] ?? []) : []
    const contact = companyContacts.length > 0 ? companyContacts[taskIndex % companyContacts.length] : undefined
    const assignee = people[task.assigneeIndex]
    const assigneeId = !serviceUser && task.assignToAdmin ? context.me.user.id : assignee?.id || undefined
    const typeInfo = taskTypes[task.taskTypeIndex]
    const typeReady = Boolean(typeInfo?.enumName)
    const status = pickStatus(
      statuses,
      task,
      typeReady ? typeInfo?.key : undefined,
      typeReady ? columnsByType.get(task.taskTypeIndex) : undefined
    )
    try {
      if (!status) throw new Error("Kein Aufgabenstatus vorhanden.")
      const created = await createTaskRecord(session, {
        subject: task.subject,
        description: task.description,
        statusId: status.id,
        priority: task.priority,
        projectId: projectId || undefined,
        responsibleId: assigneeId,
        startDate: task.startDate,
        dueDate: task.dueDate,
        fallbackStatusId: fallbackStatus?.id,
        typeName: typeReady ? typeInfo?.enumName ?? undefined : undefined,
        extraFields: taskFieldValues(plan, task, taskInputFields),
        securityRules: taskSecurity,
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
          ? `Aufgabe „${created.displayName}“ im Status „${status.name}“ angelegt (ID: ${created.id}).${fieldNote}${task.assignToAdmin && !serviceUser ? " Verantwortlich ist der verbundene Service-User." : ""}`
          : `Aufgabe „${created.displayName}“ im Status „${status.name}“ angelegt (ID: ${created.id}), ohne Aufgaben-Typ.${fieldNote}${task.assignToAdmin && !serviceUser ? " Verantwortlich ist der verbundene Service-User." : ""}`,
      })
      let taskVector = created.changeVector ?? undefined
      if (companyId) {
        try {
          taskVector = (await associateRecords(session, created.id, companyId, taskVector)) ?? taskVector
          emit({
            type: "log",
            level: "success",
            message: `Aufgabe „${created.displayName}“ mit Unternehmen „${companyName}“ verknüpft.`,
          })
        } catch (error) {
          emit({
            type: "log",
            level: "error",
            message: `Verknüpfung von „${created.displayName}“ mit Unternehmen „${companyName}“ fehlgeschlagen: ${errorText(error)}`,
          })
        }
      } else if (companyName) {
        emit({
          type: "log",
          level: "error",
          message: `Aufgabe „${created.displayName}“ konnte nicht mit „${companyName}“ verknüpft werden, weil das Unternehmen nicht angelegt wurde.`,
        })
      }
      if (contact) {
        try {
          taskVector = (await associateRecords(session, created.id, contact.id, taskVector)) ?? taskVector
          emit({
            type: "log",
            level: "success",
            message: `Aufgabe „${created.displayName}“ mit Ansprechperson „${contact.name}“ verknüpft.`,
          })
        } catch (error) {
          emit({
            type: "log",
            level: "error",
            message: `Verknüpfung von „${created.displayName}“ mit Ansprechperson „${contact.name}“ fehlgeschlagen: ${errorText(error)}`,
          })
        }
      } else if (companyName) {
        emit({
          type: "log",
          level: "error",
          message: `Aufgabe „${created.displayName}“ hat keine Ansprechperson bei „${companyName}“.`,
        })
      }
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
            changeVector: taskVector,
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
  if (calendarId) {
    const userIds = people.map((person) => person.id).filter((id) => Boolean(id))
    try {
      const share = await shareCalendarWithUsers(session, calendarId, userIds)
      if (share.failed > 0) {
        emit({
          type: "log",
          level: "error",
          message: `Kalenderfreigabe für ${share.failed} Demo-Benutzer fehlgeschlagen${share.message ? `: ${share.message}` : "."}`,
        })
      } else if (userIds.length > 0) {
        emit({
          type: "log",
          level: "success",
          message: "Demo-Benutzer können die Termine im Kalender lesen.",
        })
      }
    } catch (error) {
      emit({
        type: "log",
        level: "error",
        message: `Kalenderfreigabe fehlgeschlagen: ${errorText(error)}`,
      })
    }
  }
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

async function reloadCreatedSchema(
  session: ConsolidateSession,
  plan: DemoPlan,
  projectTypes: CreatedType[],
  taskTypes: CreatedType[],
  emit: (event: StreamEvent) => void,
  message: string
): Promise<Set<string>> {
  const created = [...projectTypes, ...taskTypes].filter((type) => type.key)
  const expectedFields = plan.taskTypes.flatMap((type, index) =>
    taskTypes[index]?.key ? type.fields.map((field) => field.key) : []
  )
  if (created.length === 0 && expectedFields.length === 0) return new Set()

  emit({ type: "log", level: "info", message })
  let available = new Set<string>()
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const schema = await loadDynamicSchema(session)
    available = schema.taskInputFields
    let pendingTypes = 0
    for (const type of projectTypes) {
      if (!type.key) continue
      const matched = matchEnumValue(schema.projectTypes, type.key, type.displayName)
      if (matched) type.enumName = matched
      else if (!type.enumName) pendingTypes += 1
    }
    for (const type of taskTypes) {
      if (!type.key) continue
      const matched = matchEnumValue(schema.taskTypes, type.key, type.displayName)
      if (matched) type.enumName = matched
      else if (!type.enumName) pendingTypes += 1
    }
    const pendingFields = expectedFields.filter((key) => !available.has(key))
    if (pendingTypes === 0 && pendingFields.length === 0) {
      emit({
        type: "log",
        level: "success",
        message: "Schema neu geladen. Neue Typen und Zusatzfelder sind sichtbar.",
      })
      return available
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  const missingTypes = [...projectTypes, ...taskTypes]
    .filter((type) => type.key && !type.enumName)
    .map((type) => type.displayName)
  const missingFields = plan.taskTypes
    .flatMap((type, index) => (taskTypes[index]?.key ? type.fields : []))
    .filter((field) => !available.has(field.key))
    .map((field) => field.label)
  const parts = [
    missingTypes.length > 0 ? `Typen noch nicht im Schema: ${missingTypes.join(", ")}.` : "",
    missingFields.length > 0 ? `Zusatzfelder noch nicht im Schema: ${missingFields.join(", ")}.` : "",
  ].filter(Boolean)
  emit({
    type: "log",
    level: "error",
    message: `Schema neu geladen, aber noch unvollständig. ${parts.join(" ")} Zugehörige Datensätze werden ohne diese Angaben angelegt.`,
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
  if (!statuses.some((status) => status.availableInTypes.length === 0)) {
    const globalName = plan.language === "de" ? "Allgemein" : "General"
    try {
      const status = await createTaskStatus(session, {
        name: globalName,
        category: "Todo",
        availableInTypes: [],
      })
      statuses.push({ ...status, availableInTypes: [] })
      emit({
        type: "log",
        level: "success",
        message: `Status „${status.name}“ gilt für alle Aufgaben (ID: ${status.id}).`,
      })
    } catch (error) {
      emit({
        type: "log",
        level: "error",
        message: `Allgemeiner Aufgabenstatus fehlgeschlagen: ${errorText(error)}`,
      })
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
  const globalStatus = statuses.find((status) => status.availableInTypes.length === 0)
  const pool = statuses.filter((status) => status.category === task.statusCategory)
  const allowed = pool.filter(
    (status) =>
      status.availableInTypes.length === 0 ||
      (typeKey ? status.availableInTypes.includes(typeKey) : false)
  )
  return allowed[0] ?? globalStatus ?? pool[0] ?? statuses[0]
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
