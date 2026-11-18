import { fetchCompanyLogo } from "@/lib/company-logo"
import { createAvatarDeck } from "@/lib/contact-avatar"
import { DEMO_PASSWORD, type DemoPlan, type PersonGender } from "@/lib/demo-plan"
import { buildTaskDocument } from "@/lib/demo-files"
import { errorText, loadImportContext, shareCalendarWithUsers } from "@/lib/consolidate"
import {
  latestBatch,
  loadEmployeeRoles,
  loadGrantedPermissions,
  loadRoleDocuments,
  MigrationSequenceError,
  readMigrationErrors,
  submitPackage,
  uploadMigrationBlob,
  waitForBatch,
  type MigrationErrorEntry,
} from "@/lib/migration-client"
import {
  buildMigrationPackage,
  graphqlDocumentId,
  migrationInstallationId,
  newBatchId,
  type MigrationItem,
  type MigrationPackage,
} from "@/lib/migration-package"
import { inferPersonGender } from "@/lib/person-gender"
import type { ConsolidateSession } from "@/lib/session"
import type { ImportSummary, StreamEvent } from "@/lib/stream-events"
import { storeZip } from "@/lib/zip-store"

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
  const total = countPlan(plan) + 2
  let completed = 0
  const tick = (label: string) => {
    completed += 1
    emit({ type: "progress", completed: Math.min(completed, total), total, label })
  }

  emit({ type: "log", level: "info", message: "Lade Rollen, Status, Formulare und Kalender." })
  const context = await loadImportContext(session)
  const defaultRole =
    context.roles.find((role) => role.name === "Standard User") ??
    context.roles.find((role) => role.isDefault && !role.isSystemRole) ??
    context.roles.find((role) => role.isDefault)
  const permissions = await loadGrantedPermissions(session)
  const existingAdmin = await findExistingAdmin(session, plan, context.me.user.id)
  if (existingAdmin) {
    const name = [existingAdmin.firstName, existingAdmin.lastName].filter(Boolean).join(" ")
    emit({
      type: "log",
      level: "info",
      message: `Der vorhandene Administrator „${name}“ wird bei den Terminen als Teilnehmer eingetragen und übernimmt 10 % der Aufgaben und Projekte.`,
    })
  }

  const installationId = migrationInstallationId(session.instanceUrl)
  let sequence = await nextSequence(session, installationId)
  emit({
    type: "log",
    level: "info",
    message: "Die Demodaten werden als ein Migrationspaket übertragen.",
  })
  const built = await assemblePackage(
    session,
    plan,
    context.me.user.id,
    defaultRole?.id,
    permissions,
    existingAdmin,
    sequence,
    emit,
    tick
  )
  let zip = storeZip(built.files.map((file) => ({ name: file.path, data: file.data })))
  tick("Paket")
  let status
  try {
    status = await submitPackage(session, installationId, zip)
  } catch (error) {
    if (!(error instanceof MigrationSequenceError)) throw error
    sequence = await nextSequence(session, installationId)
    const rebuilt = await assemblePackage(
      session,
      plan,
      context.me.user.id,
      defaultRole?.id,
      permissions,
      existingAdmin,
      sequence,
      emit,
      () => undefined
    )
    zip = storeZip(rebuilt.files.map((file) => ({ name: file.path, data: file.data })))
    built.items.splice(0, built.items.length, ...rebuilt.items)
    built.blobs.splice(0, built.blobs.length, ...rebuilt.blobs)
    built.teamSourceIds.splice(0, built.teamSourceIds.length, ...rebuilt.teamSourceIds)
    built.userSourceIds.splice(0, built.userSourceIds.length, ...rebuilt.userSourceIds)
    status = await submitPackage(session, installationId, zip)
  }
  emit({
    type: "log",
    level: "info",
    message: `Paket ${status.sequence} wird auf ${installationId} importiert.`,
  })
  const finished = status.phase === "finished" ? status : await waitForBatch(session, installationId, status.sequence)
  const errors = finished.outcome === "succeeded" ? [] : await readMigrationErrors(session, installationId, finished.sequence).catch(() => [])
  const failed = failedSourceIds(built.items, errors)
  if (finished.failureReason) {
    summary.failed += 1
    emit({ type: "log", level: "error", message: finished.failureReason })
  }
  for (const entry of errors) {
    const item = built.items.find((candidate) => candidate.sourceId === entry.sourceId)
    emit({
      type: "log",
      level: "error",
      message: `${item?.label ?? entry.file} fehlgeschlagen: ${entry.message}`,
    })
  }
  for (const item of built.items) {
    if (item.kind === "file" || item.kind === "status") continue
    if (failed.has(item.sourceId)) continue
    emit({ type: "log", level: "success", message: `${item.label} übertragen.` })
  }
  summary.projectTypes = count(built.items, "projectType", failed)
  summary.taskTypes = count(built.items, "taskType", failed)
  summary.teams = count(built.items, "team", failed)
  summary.employees = count(built.items, "employee", failed)
  summary.companies = count(built.items, "company", failed)
  summary.contacts = count(built.items, "contact", failed)
  summary.projects = count(built.items, "project", failed)
  summary.tasks = count(built.items, "task", failed)
  summary.appointments = count(built.items, "appointment", failed)
  summary.failed += errors.length

  for (const blob of built.blobs) {
    if (finished.outcome === "failed") break
    try {
      const code = await uploadMigrationBlob(session, installationId, blob)
      if (code === 201) {
        emit({ type: "log", level: "success", message: `${blob.label} hochgeladen.` })
      } else if (code === 404) {
        emit({ type: "log", level: "info", message: `${blob.label} war bereits vorhanden oder nicht mehr offen.` })
      } else {
        summary.failed += 1
        emit({ type: "log", level: "error", message: `${blob.label} fehlgeschlagen (HTTP ${code}).` })
      }
    } catch (error) {
      summary.failed += 1
      emit({ type: "log", level: "error", message: `${blob.label} fehlgeschlagen: ${errorText(error)}` })
    }
  }
  tick("Dateien")

  await shareCalendars(session, plan, emit)

  emit({
    type: "log",
    level: summary.failed ? "error" : "success",
    message: summary.failed
      ? `Import beendet. ${summary.failed} Schritte sind fehlgeschlagen.`
      : "Import beendet.",
  })
  return summary
}

async function assemblePackage(
  session: ConsolidateSession,
  plan: DemoPlan,
  serviceUserId: string,
  defaultRoleId: string | undefined,
  permissions: string[],
  existingAdmin: { firstName: string; lastName: string; email: string; id: string } | undefined,
  sequence: number,
  emit: (event: StreamEvent) => void,
  tick: (label: string) => void
): Promise<MigrationPackage> {
  const people = [
    ...plan.employees.map((employee, index) => ({
      key: `employee:${index}`,
      name: `${employee.firstName} ${employee.lastName}`,
      gender: employee.gender ?? inferPersonGender(employee.firstName),
    })),
    ...plan.contacts.map((contact, index) => ({
      key: `contact:${index}`,
      name: `${contact.firstName} ${contact.lastName}`,
      gender: contact.gender ?? inferPersonGender(contact.firstName),
    })),
  ]
  const avatars = assignAvatars(people, emit)
  const logos: { index: number; body: Buffer }[] = []
  for (const [index, company] of plan.companies.entries()) {
    try {
      logos.push({ index, body: await fetchCompanyLogo(index) })
    } catch (error) {
      emit({
        type: "log",
        level: "error",
        message: `Firmenlogo für „${company.name}“ nicht geladen: ${errorText(error)}`,
      })
    }
    tick("Unternehmen")
  }
  for (const contact of plan.contacts) tick(contact.firstName)
  for (const employee of plan.employees) tick(employee.firstName)
  const taskFiles = plan.tasks.flatMap((task, taskIndex) => {
    tick("Aufgaben")
    if (!task.file) return []
    return [{
      taskIndex,
      name: task.file.name,
      versions: Array.from({ length: task.file.versions }, (_, version) =>
        buildTaskDocument({
          kind: task.file!.kind,
          title: task.subject,
          description: task.description,
          version: version + 1,
          versions: task.file!.versions,
          language: plan.language,
        })
      ),
    }]
  })
  for (const project of plan.projects) tick(project.name)
  for (const appointment of plan.appointments) tick(appointment.title)
  for (const type of plan.projectTypes) tick(type.displayName)
  for (const type of plan.taskTypes) tick(type.displayName)
  for (const team of plan.teams) tick(team.name)

  return buildMigrationPackage({
    plan,
    instanceUrl: session.instanceUrl,
    sequence,
    batchId: newBatchId(),
    serviceUserId: graphqlDocumentId(serviceUserId),
    existingAdmin: existingAdmin
      ? {
          firstName: existingAdmin.firstName,
          lastName: existingAdmin.lastName,
          email: existingAdmin.email,
          targetId: graphqlDocumentId(existingAdmin.id),
        }
      : undefined,
    defaultRoleId: defaultRoleId ? graphqlDocumentId(defaultRoleId) : undefined,
    permissions: migrationPermissions(permissions),
    avatars: [...avatars.entries()].map(([key, picture]) => ({
      key,
      body: picture.body,
      contentType: picture.contentType,
    })),
    logos,
    taskFiles,
  })
}

async function nextSequence(session: ConsolidateSession, installationId: string): Promise<number> {
  const latest = await latestBatch(session, installationId)
  if (!latest) return 1
  if (latest.phase === "importing") {
    const finished = await waitForBatch(session, installationId, latest.sequence)
    return finished.lastAppliedSequence + 1
  }
  return latest.lastAppliedSequence + 1
}

function failedSourceIds(items: MigrationItem[], errors: MigrationErrorEntry[]): Set<string> {
  const failed = new Set<string>()
  for (const error of errors) {
    if (error.sourceId) {
      failed.add(error.sourceId)
      continue
    }
    for (const item of items) {
      if (item.file === error.file) failed.add(item.sourceId)
    }
  }
  return failed
}

function count(items: MigrationItem[], kind: MigrationItem["kind"], failed: Set<string>): number {
  return items.filter((item) => item.kind === kind && !failed.has(item.sourceId)).length
}

async function findExistingAdmin(
  session: ConsolidateSession,
  plan: DemoPlan,
  connectedUserId: string
): Promise<{ firstName: string; lastName: string; email: string; id: string } | undefined> {
  try {
    const demoEmails = new Set(plan.employees.map((employee) => employee.email.trim().toLowerCase()))
    const [roles, employees] = await Promise.all([loadRoleDocuments(session), loadEmployeeRoles(session)])
    const adminRole = roles.find((role) => role.name.trim().toLowerCase() === "administrator")
    if (!adminRole) return undefined
    const eligible = employees.filter((user) => {
      const email = user.email.trim().toLowerCase()
      return (
        user.isActive &&
        !user.isSystem &&
        email.length > 0 &&
        !email.startsWith("alt_") &&
        !demoEmails.has(email) &&
        user.roleIds.includes(adminRole.id)
      )
    })
    const chosen = eligible.find((user) => user.id === connectedUserId) ?? eligible[0]
    if (!chosen) return undefined
    const words = chosen.displayName.trim().split(/\s+/).filter((word) => word && !word.includes("@"))
    return {
      firstName: words[0] || chosen.displayName.trim() || chosen.email,
      lastName: words.slice(1).join(" "),
      email: chosen.email.trim(),
      id: chosen.id,
    }
  } catch {
    return undefined
  }
}

async function shareCalendars(
  session: ConsolidateSession,
  plan: DemoPlan,
  emit: (event: StreamEvent) => void
) {
  try {
    const [context, employees] = await Promise.all([
      loadImportContext(session),
      loadEmployeeRoles(session),
    ])
    const emails = new Set(plan.employees.map((employee) => employee.email.trim().toLowerCase()))
    const userIds = employees
      .filter((user) => emails.has(user.email.trim().toLowerCase()))
      .map((user) => user.id)
    const calendars = context.calendars.filter((calendar) => userIds.includes(calendar.owner.id))
    let failed = 0
    for (const calendar of calendars) {
      const share = await shareCalendarWithUsers(session, calendar.id, userIds)
      failed += share.failed
    }
    if (failed > 0) {
      emit({ type: "log", level: "error", message: `Kalenderfreigabe für ${failed} Demo-Benutzer fehlgeschlagen.` })
    } else if (calendars.length > 0) {
      emit({ type: "log", level: "success", message: "Demo-Benutzer können die Termine im Kalender lesen." })
    }
  } catch (error) {
    emit({ type: "log", level: "error", message: `Kalenderfreigabe fehlgeschlagen: ${errorText(error)}` })
  }
}

function assignAvatars(
  people: { key: string; name: string; gender: PersonGender }[],
  emit: (event: StreamEvent) => void
) {
  const assigned = new Map<string, { body: Buffer; contentType: "image/webp" }>()
  try {
    const deck = createAvatarDeck()
    for (const person of people) {
      const picture = deck.take(person.gender) ?? (person.gender === "neutral" ? undefined : deck.take("neutral"))
      if (picture) assigned.set(person.key, picture)
      else {
        emit({
          type: "log",
          level: "error",
          message: `Kein weiteres Avatarbild für „${person.name}“.`,
        })
      }
    }
  } catch (error) {
    emit({ type: "log", level: "error", message: `Avatarbilder nicht geladen: ${errorText(error)}` })
  }
  return assigned
}

function migrationPermissions(keys: string[]): string[] {
  return Array.from(
    new Set(
      keys.flatMap((key) => {
        const collection = /^DataEntries\.(Contact|Company|Project|Task)$/.exec(key)
        return collection ? [`Permissions.DataEntries.${collection[1]}.Edit`] : []
      })
    )
  )
}

function countPlan(plan: DemoPlan): number {
  return (
    plan.projectTypes.length +
    plan.taskTypes.length +
    plan.teams.length +
    plan.employees.length +
    plan.companies.length +
    plan.contacts.length +
    plan.projects.length +
    plan.tasks.length +
    plan.appointments.length
  )
}
