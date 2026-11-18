import { createHash, randomBytes } from "node:crypto"

import { DEMO_PASSWORD, evenIndexes, type DemoPlan, type PersonGender } from "@/lib/demo-plan"
import { inferPersonGender } from "@/lib/person-gender"
import { assignFieldKey, storedFieldValue, type TaskFieldDefinition } from "@/lib/task-fields"

const SOURCE_SYSTEM = "Demo"
const SCHEMA_VERSION = "1.0"
const COLORS = ["teal", "green", "yellow", "orange", "red", "purple", "blue", "sky", "amber", "rose"]
const SALUTATION_CODE: Record<PersonGender, string> = {
  male: "MALE_FORM",
  female: "FEMALE_FORM",
  neutral: "NEUTRAL_FORM",
}
const VALUE_TYPES: Record<TaskFieldDefinition["valueType"], string> = {
  Text: "text",
  Number: "number",
  Date: "date",
  Checkbox: "checkbox",
  Time: "time",
  ComboBox: "comboBox",
}

export type MigrationBlob = {
  id: string
  body: Buffer
  contentType: string
  label: string
}

export type MigrationItem = {
  kind:
    | "projectType"
    | "taskType"
    | "team"
    | "employee"
    | "company"
    | "contact"
    | "project"
    | "task"
    | "appointment"
    | "adminAppointment"
    | "file"
    | "status"
  sourceId: string
  label: string
  file: string
}

export type MigrationPackage = {
  installationId: string
  sequence: number
  files: { path: string; type: string; data: Buffer }[]
  blobs: MigrationBlob[]
  items: MigrationItem[]
  userSourceIds: { sourceId: string }[]
  teamSourceIds: { sourceId: string; name: string }[]
}

export type PackageBinary = { body: Buffer; contentType: string }

type AccessLevel = "read" | "edit" | "manage"

type Security = {
  custom: false
  users: Record<string, "manage">
  roles: Record<string, AccessLevel>
}

export function migrationInstallationId(instanceUrl: string): string {
  const origin = new URL(instanceUrl).origin
  return `demo${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`
}

export function graphqlDocumentId(id: string): string {
  const decoded = Buffer.from(id, "base64").toString("utf8")
  const split = decoded.indexOf(":")
  if (split <= 0 || !decoded.slice(split + 1).includes("/")) return id
  return decoded.slice(split + 1)
}

export function newBatchId(): string {
  return randomBytes(16).toString("hex")
}

export function buildMigrationPackage(input: {
  plan: DemoPlan
  instanceUrl: string
  sequence: number
  batchId: string
  serviceUserId: string
  existingAdmin?: { firstName: string; lastName: string; email: string; targetId: string }
  defaultRoleId?: string
  permissions: string[]
  avatars: { key: string; body: Buffer; contentType: string }[]
  logos: { index: number; body: Buffer }[]
  taskFiles: { taskIndex: number; name: string; versions: PackageBinary[] }[]
}): MigrationPackage {
  const ids = new IdFactory(input.sequence)
  const serviceSource = "svc"
  const adminSource = !input.existingAdmin?.targetId
    ? ""
    : input.existingAdmin.targetId === input.serviceUserId
      ? serviceSource
      : "adm"
  const defaultRoleSource = input.defaultRoleId ? "std" : ""
  const access = (teamSource: string, standardUser: AccessLevel = "edit") => ({
    users: { [serviceSource]: "manage" as const },
    roles: {
      ...(defaultRoleSource ? { [defaultRoleSource]: standardUser } : {}),
      ...(teamSource ? { [teamSource]: "read" as const } : {}),
    },
  })
  const security = (teamSource: string, standardUser: AccessLevel = "edit"): Security => ({
    custom: false,
    ...access(teamSource, standardUser),
  })
  const meta = {
    createdAt: new Date().toISOString(),
    createdBy: serviceSource,
    modifiedAt: new Date().toISOString(),
    modifiedBy: serviceSource,
  }
  const items: MigrationItem[] = []
  const blobs: MigrationBlob[] = []
  const attachments: Record<string, unknown>[] = []
  const mappings: Record<string, unknown>[] = [
    { type: "user", sourceId: serviceSource, targetId: input.serviceUserId },
  ]
  if (input.defaultRoleId && defaultRoleSource) {
    mappings.push({ type: "role", sourceId: defaultRoleSource, targetId: input.defaultRoleId })
  }
  if (adminSource && adminSource !== serviceSource && input.existingAdmin?.targetId) {
    mappings.push({ type: "user", sourceId: adminSource, targetId: input.existingAdmin.targetId })
  }
  const adminProjectIndexes = new Set(
    evenIndexes(input.plan.projects.length, Math.round(input.plan.projects.length * 0.1))
  )
  const adminTaskIndexes = new Set(evenIndexes(input.plan.tasks.length, Math.round(input.plan.tasks.length * 0.1)))

  const projectTypeKeys = keyed(input.plan.projectTypes.map((type) => type.displayName))
  const taskTypeKeys = keyed(input.plan.taskTypes.map((type) => type.displayName))
  const projectTypes = input.plan.projectTypes.map((type, index) => {
    const key = projectTypeKeys[index]
    items.push({
      kind: "projectType",
      sourceId: key,
      label: `Projekt-Typ „${type.displayName}“`,
      file: "dataforms.ndjson",
    })
    return {
      key,
      displayName: type.displayName,
      color: COLORS[index % COLORS.length],
      template: access(""),
    }
  })
  const taskTypes = input.plan.taskTypes.map((type, index) => {
    const key = taskTypeKeys[index]
    items.push({
      kind: "taskType",
      sourceId: key,
      label: `Aufgaben-Typ „${type.displayName}“`,
      file: "dataforms.ndjson",
    })
    const additionalFields = type.fields.map((field) => fieldDefinition(field))
    return {
      key,
      displayName: type.displayName,
      color: COLORS[index % COLORS.length],
      level: "task",
      template: access("", "edit"),
      ...(additionalFields.length > 0 ? { additionalFields } : {}),
    }
  })

  const statuses: Record<string, unknown>[] = []
  const statusIds = new Map<string, string>()
  input.plan.taskTypes.forEach((type, typeIndex) => {
    type.statuses.forEach((status, statusIndex) => {
      const sourceId = ids.next("status")
      statusIds.set(`${typeIndex}:${status.name.trim().toLowerCase()}`, sourceId)
      items.push({
        kind: "status",
        sourceId,
        label: `Status „${status.name}“`,
        file: "taskstatuses.ndjson",
      })
      statuses.push({
        $source: { id: sourceId },
        $meta: meta,
        name: status.name,
        category: categoryName(status.category),
        availableInTypes: [taskTypeKeys[typeIndex]],
        order: (statusIndex + 1) * 10,
      })
    })
  })

  const teams = input.plan.teams.map((team) => {
    const sourceId = ids.next("team")
    items.push({ kind: "team", sourceId, label: `Team „${team.name}“`, file: "roles.ndjson" })
    return { sourceId, name: team.name }
  })
  const roles = teams.map((team) => ({
    $source: { id: team.sourceId },
    $meta: meta,
    displayName: team.name,
    permissions: input.permissions,
  }))

  const employeeContacts: Record<string, unknown>[] = []
  const users: Record<string, unknown>[] = []
  const userSourceIds: MigrationPackage["userSourceIds"] = []
  input.plan.employees.forEach((employee, index) => {
    const sourceId = ids.next("user")
    const contactId = ids.next("contact")
    const team = teams[employee.teamIndex] ?? teams[0]
    const gender = employee.gender ?? inferPersonGender(employee.firstName)
    userSourceIds.push({ sourceId })
    items.push({
      kind: "employee",
      sourceId,
      label: `Mitarbeiter „${employee.firstName} ${employee.lastName}“`,
      file: "users.ndjson",
    })
    items.push({
      kind: "contact",
      sourceId: contactId,
      label: `Kontakt „${employee.firstName} ${employee.lastName}“`,
      file: "entries.Contact.ndjson",
    })
    const avatarId = attachImage(blobs, attachments, items, {
      image: input.avatars.find((avatar) => avatar.key === `employee:${index}`),
      sourceId: ids.next("avatar"),
      ownerType: "Contact",
        ownerId: contactId,
        name: `${employee.firstName} ${employee.lastName}`,
      })
    employeeContacts.push(
      contactRecord({
        sourceId: contactId,
        meta,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        position: employee.position,
        gender,
        avatarId,
        owner: sourceId,
        security: security(team?.sourceId ?? "", "manage"),
      })
    )
    users.push({
      $source: { id: sourceId },
      $meta: meta,
      email: employee.email,
      type: "employee",
      active: true,
      roles: [team?.sourceId, defaultRoleSource].filter(Boolean),
      contact: contactId,
      password: { format: "plaintext", hash: DEMO_PASSWORD },
      template: {
        users: { [serviceSource]: "manage" },
        roles: access(team?.sourceId ?? "").roles,
      },
    })
  })

  const demoOwner = (index: number) =>
    userSourceIds.length === 0 ? undefined : userSourceIds[index % userSourceIds.length].sourceId

  const companies = input.plan.companies.map((company, index) => {
    const sourceId = ids.next("company")
    items.push({
      kind: "company",
      sourceId,
      label: `Unternehmen „${company.name}“`,
      file: "entries.Company.ndjson",
    })
    const logo = input.logos.find((entry) => entry.index === index)
    const logoId = logo
      ? attachImage(blobs, attachments, items, {
          image: { body: logo.body, contentType: "image/png" },
          sourceId: ids.next("logo"),
          ownerType: "Company",
          ownerId: sourceId,
          name: company.name,
        })
      : ""
    const fields: Record<string, unknown> = { name: company.name }
    if (company.phone) fields.phoneNumber = [company.phone]
    if (company.email) fields.email = [company.email]
    if (company.street || company.zipCode || company.city || company.country) {
      fields.address = {
        street: company.street,
        zipCode: company.zipCode,
        city: company.city,
        country: company.country,
      }
    }
    if (company.note) fields.notes = { html: `<p>${escapeHtml(company.note)}</p>` }
    if (logoId) fields.logo = logoId
    const owner = demoOwner(index)
    if (owner) fields.owner = owner
    return {
      sourceId,
      record: {
        $source: { id: sourceId },
        $meta: meta,
        fields,
        security: security("", "manage"),
      },
    }
  })

  const contacts = input.plan.contacts.map((contact, index) => {
    const sourceId = ids.next("contact")
    const company = companies[contact.companyIndex]
    const gender = contact.gender ?? inferPersonGender(contact.firstName)
    items.push({
      kind: "contact",
      sourceId,
      label: `Kontakt „${contact.firstName} ${contact.lastName}“`,
      file: "entries.Contact.ndjson",
    })
    const avatarId = attachImage(blobs, attachments, items, {
      image: input.avatars.find((avatar) => avatar.key === `contact:${index}`),
      sourceId: ids.next("avatar"),
      ownerType: "Contact",
      ownerId: sourceId,
      name: `${contact.firstName} ${contact.lastName}`,
    })
    return {
      sourceId,
      companyIndex: contact.companyIndex,
      record: contactRecord({
        sourceId,
        meta,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
        position: contact.position,
        department: contact.department,
        companyId: company?.sourceId,
        gender,
        avatarId,
        owner: demoOwner(index),
        security: security("", "manage"),
      }),
    }
  })

  const projects = input.plan.projects.map((project, index) => {
    const sourceId = ids.next("project")
    const team = teams[project.teamIndex] ?? teams[0]
    const manager = userSourceIds[project.managerIndex]
    const responsible = adminSource && adminProjectIndexes.has(index) ? adminSource : manager?.sourceId
    const company = companies[project.companyIndex]
    items.push({
      kind: "project",
      sourceId,
      label: `Projekt „${project.name}“`,
      file: "entries.Project.ndjson",
    })
    return {
      sourceId,
      record: {
        $source: { id: sourceId },
        $meta: meta,
        dataTypes: [projectTypeKeys[project.projectTypeIndex]].filter(Boolean),
        fields: {
          name: project.name,
          startDate: project.startDate,
          endDate: project.endDate,
          ...(responsible ? { responsible } : {}),
          description: { html: `<p>${escapeHtml(project.summary)}</p>` },
        },
        ...(company ? { associations: [{ type: "Company", id: company.sourceId, role: "manual" }] } : {}),
        security: security(team?.sourceId ?? ""),
      },
    }
  })

  const tasks = input.plan.tasks.map((task, index) => {
    const sourceId = ids.next("task")
    const project = projects[task.projectIndex]
    const projectPlan = input.plan.projects[task.projectIndex]
    const team = teams[projectPlan?.teamIndex ?? 0] ?? teams[0]
    const assignee = userSourceIds[task.assigneeIndex]
    const typeKey = taskTypeKeys[task.taskTypeIndex]
    const namedStatus = statusIds.get(`${task.taskTypeIndex}:${task.statusName.trim().toLowerCase()}`)
    const company = projectPlan ? companies[projectPlan.companyIndex] : undefined
    const companyContacts = contacts.filter((contact) => contact.companyIndex === projectPlan?.companyIndex)
    const contact = companyContacts.length > 0 ? companyContacts[index % companyContacts.length] : undefined
    const file = input.taskFiles.find((entry) => entry.taskIndex === index)
    const attachmentId = file ? ids.next("file") : ""
    items.push({
      kind: "task",
      sourceId,
      label: `Aufgabe „${task.subject}“`,
      file: "entries.Task.ndjson",
    })
    const fields: Record<string, unknown> = {
      subject: task.subject,
      description: { html: `<p>${escapeHtml(task.description)}</p>` },
      priority: task.priority.toLowerCase(),
      status: namedStatus ?? builtinStatus(task.statusCategory),
      startDate: task.startDate,
      dueDate: task.dueDate,
      ...(project ? { project: project.sourceId } : {}),
      ...(adminSource && adminTaskIndexes.has(index) ? { responsible: adminSource } : assignee ? { responsible: assignee.sourceId } : {}),
    }
    const definitions = input.plan.taskTypes[task.taskTypeIndex]?.fields ?? []
    for (const entry of task.fieldValues) {
      const definition = definitions.find((field) => field.key === entry.key)
      if (!definition) continue
      const value = migrationFieldValue(definition, entry.value, task.dueDate, input.plan.language, index)
      if (value !== undefined) fields[definition.key] = value
    }
    const associations = [
      company ? { type: "Company", id: company.sourceId, role: "manual" } : undefined,
      contact ? { type: "Contact", id: contact.sourceId, role: "manual" } : undefined,
    ].filter(Boolean)
    if (file && attachmentId) {
      const versions = file.versions.map((version, versionIndex) => {
        const blobId = `${attachmentId}v${versionIndex + 1}`
        blobs.push({
          id: blobId,
          body: version.body,
          contentType: version.contentType,
          label: `Datei „${file.name}“, Version ${versionIndex + 1}`,
        })
        return {
          number: versionIndex + 1,
          status: "approved",
          blobId,
          size: version.body.length,
          contentType: version.contentType,
          createdAt: meta.createdAt,
          createdBy: serviceSource,
          approvedAt: meta.createdAt,
          approvedBy: serviceSource,
          approvalComment: `Version ${versionIndex + 1}`,
        }
      })
      const last = versions[versions.length - 1]
      items.push({
        kind: "file",
        sourceId: attachmentId,
        label: `Datei „${file.name}“`,
        file: "attachments.ndjson",
      })
      attachments.push({
        $source: { id: attachmentId },
        $meta: meta,
        owner: { type: "Task", id: sourceId },
        fileName: file.name,
        contentType: last.contentType,
        size: last.size,
        blobId: last.blobId,
        ...(versions.length > 1 ? { versions } : {}),
      })
      return {
        task: {
          $source: { id: sourceId },
          $meta: meta,
          ...(typeKey ? { dataTypes: [typeKey] } : {}),
          fields,
          attachments: [attachmentId],
          ...(associations.length > 0 ? { associations } : {}),
          security: security(team?.sourceId ?? "", "edit"),
        },
      }
    }
    return {
      task: {
        $source: { id: sourceId },
        $meta: meta,
        ...(typeKey ? { dataTypes: [typeKey] } : {}),
        fields,
        ...(associations.length > 0 ? { associations } : {}),
        security: security(team?.sourceId ?? "", "edit"),
      },
    }
  })

  const events = input.plan.appointments.flatMap((appointment) => {
    const sourceId = ids.next("event")
    const project = projects[appointment.projectIndex]
    const attendees: { firstName: string; lastName: string; email: string }[] = appointment.attendeeIndexes
      .map((attendee) => input.plan.employees[attendee])
      .filter((person) => person?.email)
    if (
      input.existingAdmin &&
      !attendees.some((person) => person.email.trim().toLowerCase() === input.existingAdmin?.email.trim().toLowerCase())
    ) {
      attendees.push(input.existingAdmin)
    }
    const owner = userSourceIds[appointment.attendeeIndexes[0]] ?? userSourceIds[0]
    const eventFor = (id: string, eventOwner: string) => ({
      $source: { id },
      $meta: meta,
      owner: eventOwner,
      ical: calendarEvent({
        uid: id,
        title: appointment.title,
        location: appointment.location,
        date: appointment.startDate,
        start: appointment.startTime,
        end: appointment.endTime,
        organizer: attendees[0],
        attendees,
      }),
      ...(project ? { associations: [{ type: "Project", id: project.sourceId, role: "manual" }] } : {}),
    })
    items.push({
      kind: "appointment",
      sourceId,
      label: `Termin „${appointment.title}“`,
      file: "events.ndjson",
    })
    const records = [eventFor(sourceId, owner?.sourceId ?? serviceSource)]
    if (adminSource) {
      const adminEventId = ids.next("event")
      items.push({
        kind: "adminAppointment",
        sourceId: adminEventId,
        label: `Termin „${appointment.title}“ im Kalender des Administrators`,
        file: "events.ndjson",
      })
      records.push(eventFor(adminEventId, adminSource))
    }
    return records
  })

  const files = [
    file("mappings", mappings),
    file("dataforms", [
      ...(projectTypes.length > 0 ? [{ collection: "Project", types: projectTypes }] : []),
      ...(taskTypes.length > 0 ? [{ collection: "Task", types: taskTypes }] : []),
    ]),
    file("taskstatuses", statuses),
    file("roles", roles),
    file("users", users),
    file("entries.Company", companies.map((company) => company.record)),
    file("entries.Contact", uniqueContacts(employeeContacts, contacts.map((contact) => contact.record))),
    file("entries.Project", projects.map((project) => project.record)),
    file("entries.Task", tasks.map((task) => task.task)),
    file("attachments", attachments),
    file("events", events),
  ].filter((entry) => entry.records > 0)

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    source: { system: SOURCE_SYSTEM, version: "1", installationId: migrationInstallationId(input.instanceUrl) },
    batch: { id: input.batchId, sequence: input.sequence, createdAt: meta.createdAt },
    files: files.map((entry) => ({
      type: entry.type,
      path: entry.path,
      records: entry.records,
      sha256: createHash("sha256").update(entry.data).digest("hex"),
    })),
  }

  return {
    installationId: manifest.source.installationId,
    sequence: input.sequence,
    files: [{ path: "manifest.json", type: "manifest", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }, ...files],
    blobs: blobs.filter((blob) => blob.body.length > 0),
    items,
    userSourceIds,
    teamSourceIds: teams,
  }
}

function attachImage(
  blobs: MigrationBlob[],
  attachments: Record<string, unknown>[],
  items: MigrationItem[],
  input: {
    image: { body: Buffer; contentType: string } | undefined
    sourceId: string
    ownerType: "Contact" | "Company"
    ownerId: string
    name: string
  }
): string {
  if (!input.image || !input.ownerId) return ""
  const label = input.ownerType === "Company" ? `Logo „${input.name}“` : `Avatar „${input.name}“`
  blobs.push({
    id: input.sourceId,
    body: input.image.body,
    contentType: input.image.contentType,
    label,
  })
  items.push({ kind: "file", sourceId: input.sourceId, label, file: "attachments.ndjson" })
  attachments.push({
    $source: { id: input.sourceId },
    owner: { type: input.ownerType, id: input.ownerId },
    fileName: input.image.contentType === "image/png" ? `${input.sourceId}.png` : `${input.sourceId}.webp`,
    contentType: input.image.contentType,
    size: input.image.body.length,
    blobId: input.sourceId,
  })
  return input.sourceId
}

function contactRecord(input: {
  sourceId: string
  meta: Record<string, string>
  firstName: string
  lastName: string
  email: string
  phone?: string
  position?: string
  department?: string
  companyId?: string
  gender: PersonGender
  avatarId: string
  owner?: string
  security: Security
}): Record<string, unknown> {
  const salutation = SALUTATION_CODE[input.gender]
  const fields: Record<string, unknown> = {
    firstName: input.firstName,
    lastName: input.lastName,
    email: [input.email],
  }
  if (input.phone) fields.phoneNumber = [input.phone]
  if (salutation) fields.salutation = salutation
  if (input.avatarId) fields.avatar = input.avatarId
  if (input.owner) fields.owner = input.owner
  if (input.companyId) {
    fields.company = [
      {
        company: input.companyId,
        ...(input.position ? { position: input.position } : {}),
        ...(input.department ? { department: input.department } : {}),
        includeInCrossReferences: true,
      },
    ]
  }
  return {
    $source: { id: input.sourceId },
    $meta: input.meta,
    fields,
    security: input.security,
  }
}

function fieldDefinition(field: TaskFieldDefinition): Record<string, unknown> {
  return {
    kind: "value",
    key: field.key,
    label: field.label,
    valueType: VALUE_TYPES[field.valueType],
    required: false,
    selection: "single",
    section: "additional",
    size: "half",
    searchable: field.valueType === "Text" || field.valueType === "Number" || field.valueType === "ComboBox",
    ...(field.helpText ? { helpText: field.helpText } : {}),
    ...(field.valueType === "Number" ? { maxDecimals: 1 } : {}),
    ...(field.valueType === "ComboBox" ? { comboBoxOptions: field.options } : {}),
  }
}

function migrationFieldValue(
  field: TaskFieldDefinition,
  raw: string,
  dueDate: string,
  language: "de" | "en",
  index: number
): string | number | boolean | undefined {
  const stored = storedFieldValue(field, raw, dueDate, language, index)
  if (!stored) return undefined
  if (field.valueType === "Number") {
    const number = Number(stored.replace(",", "."))
    return Number.isFinite(number) ? number : undefined
  }
  if (field.valueType === "Checkbox") return stored === "true"
  if (field.valueType === "Time") return stored.length === 5 ? `${stored}:00` : stored
  return stored
}

function categoryName(category: string): "todo" | "inProgress" | "done" {
  if (category === "InProgress") return "inProgress"
  if (category === "Done") return "done"
  return "todo"
}

function builtinStatus(category: string): string {
  if (category === "InProgress") return "@inprogress"
  if (category === "Done") return "@done"
  return "@todo"
}

function keyed(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => assignFieldKey(name, used))
}

const ID_CODE: Record<string, string> = {
  service: "u",
  user: "u",
  role: "r",
  team: "r",
  status: "s",
  contact: "c",
  company: "f",
  project: "p",
  task: "t",
  event: "e",
  avatar: "a",
  logo: "a",
  file: "a",
}

class IdFactory {
  private readonly counts = new Map<string, number>()

  constructor(private readonly sequence: number) {}

  next(kind: string): string {
    const code = ID_CODE[kind] ?? "x"
    const count = (this.counts.get(code) ?? 0) + 1
    this.counts.set(code, count)
    return `${this.sequence}${code}${count}`
  }
}

function uniqueContacts(employees: Record<string, unknown>[], customers: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set(employees.map((record) => (record.$source as { id: string }).id))
  return [
    ...employees,
    ...customers.filter((record) => !seen.has((record.$source as { id: string }).id)),
  ]
}

function file(type: string, records: unknown[]): { path: string; type: string; data: Buffer; records: number } {
  const lines = records.filter(Boolean).map((record) => JSON.stringify(record))
  return {
    path: `${type}.ndjson`,
    type,
    records: lines.length,
    data: Buffer.from(lines.join("\n")),
  }
}

function calendarEvent(input: {
  uid: string
  title: string
  location: string
  date: string
  start: string
  end: string
  organizer?: { firstName: string; lastName: string; email: string }
  attendees: { firstName: string; lastName: string; email: string }[]
}): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Consolidate Demo//DE",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Berlin",
    "BEGIN:STANDARD",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "END:STANDARD",
    "BEGIN:DAYLIGHT",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "END:DAYLIGHT",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${ics(input.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/Berlin:${icsDate(input.date, input.start)}`,
    `DTEND;TZID=Europe/Berlin:${icsDate(input.date, input.end)}`,
    `SUMMARY:${ics(input.title)}`,
    ...(input.location ? [`LOCATION:${ics(input.location)}`] : []),
    ...(input.organizer
      ? [`ORGANIZER;CN=${ics(`${input.organizer.firstName} ${input.organizer.lastName}`)}:mailto:${input.organizer.email}`]
      : []),
    ...input.attendees.map(
      (person) => `ATTENDEE;CN=${ics(`${person.firstName} ${person.lastName}`)}:mailto:${person.email}`
    ),
    "END:VEVENT",
    "END:VCALENDAR",
  ]
  return lines.map(fold).join("\r\n")
}

function icsDate(date: string, time: string): string {
  const clock = /^(\d{2}):(\d{2})/.exec(time)
  const hours = clock?.[1] ?? "09"
  const minutes = clock?.[2] ?? "00"
  return `${date.replace(/-/g, "")}T${hours}${minutes}00`
}

function ics(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;")
}

function fold(line: string): string {
  if (line.length <= 73) return line
  const parts = [line.slice(0, 73)]
  let rest = line.slice(73)
  while (rest) {
    parts.push(` ${rest.slice(0, 72)}`)
    rest = rest.slice(72)
  }
  return parts.join("\r\n")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
