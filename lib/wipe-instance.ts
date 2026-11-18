import { collectMessages, sessionGraphql } from "@/lib/consolidate"
import type { ConsolidateSession } from "@/lib/session"
import type { StreamEvent } from "@/lib/stream-events"

type Emit = (event: StreamEvent) => void
type PayloadError = { message?: string | null } | null

type EntryRef = {
  id: string
  displayName: string
  dataCollection: string
  user?: { id: string } | null
}

type FormType = {
  key: string
  displayName: string
  archived: boolean
  canBeDeleted: boolean
}

type DataForm = {
  dataCollection: string
  displayName: string
  archived: boolean
  types: FormType[]
}

type ListedUser = {
  id: string
  email: string
  displayName: string
  isSystem: boolean
  isActive: boolean
  type: "Employee" | "Service" | "Restricted"
  roles: { id: string }[]
  contact: { id: string } | null
}

const PAGE_SIZE = 100
const BATCH_SIZE = 25
const INTERVAL_START = "2000-01-01T00:00:00 UTC +00"
const INTERVAL_END = "2100-01-01T00:00:00 UTC +00"

const LIST_ENTRIES = `
  query ListEntries($collection: DataCollection!, $skip: Int!, $take: Int!) {
    dataEntries(
      dataCollection: $collection
      skip: $skip
      take: $take
      includeInactive: true
      favoritesOnly: false
    ) {
      items {
        id
        displayName
        dataCollection
        ... on Contact { user { id } }
      }
    }
  }
`

const LIST_TRASH = `
  query ListTrash($skip: Int!, $take: Int!) {
    dataEntriesInTrash(skip: $skip, take: $take) {
      items {
        id
        displayName
        dataCollection
        ... on Contact { user { id } }
      }
    }
  }
`

const MOVE_TO_TRASH = `
  mutation MoveToTrash($input: MoveToTrashInput!) {
    moveToTrash(input: $input) {
      errors { ... on Error { message } }
    }
  }
`

const DELETE_PERMANENTLY = `
  mutation DeletePermanently($input: DeleteDataEntriesPermanentlyInput!) {
    deleteDataEntriesPermanently(input: $input) {
      success
      errors { ... on Error { message } }
    }
  }
`

const FORMS = `
  query WipeForms {
    dataForms(returnAll: true) {
      dataCollection
      displayName
      archived
      types { key displayName archived canBeDeleted }
    }
  }
`

const DELETE_TYPE = `
  mutation DeleteType($input: DeleteDataTypeInput!) {
    deleteDataType(input: $input) {
      success
      errors { ... on Error { message } }
    }
  }
`

const CALENDARS = `
  query WipeCalendars {
    calendars { id }
  }
`

const EVENTS = `
  query WipeEvents($calendars: [ID!]!, $start: ZonedDateTime!, $end: ZonedDateTime!) {
    calendarEventsInInterval(calendars: $calendars, start: $start, end: $end) {
      events { id seriesMasterId title }
    }
  }
`

const DELETE_EVENT = `
  mutation DeleteEvent($input: DeleteCalendarEventInput!) {
    deleteCalendarEvent(input: $input) { success }
  }
`

const CURRENT_USER = `
  query WipeCurrentUser {
    me { user { id } }
  }
`

const USERS = `
  query WipeUsers($userType: UserType!) {
    allUsers(userType: $userType) {
      id
      email
      displayName
      isSystem
      isActive
      type
      roles { id }
      contact { id }
    }
  }
`

const TEAMS = `
  query WipeTeams {
    activeTeams {
      id
      name
      isSystemRole
      isDefault
      permissions { key value }
    }
  }
`

const DEACTIVATE_TEAM = `
  mutation DeactivateTeam($input: UpdateRoleInput!) {
    updateRole(input: $input) {
      role { id }
    }
  }
`

const UPDATE_USER = `
  mutation DeactivateUser($input: UpdateUserInput!) {
    updateUser(input: $input) {
      user { id isActive email }
      errors { ... on Error { message } }
    }
  }
`

const CREATE_PLACEHOLDER_CONTACT = `
  mutation CreatePlaceholderContact($input: CreateContactInput!) {
    createContact(input: $input) {
      contact { id }
    }
  }
`

function chunks<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

async function readData<T>(
  session: ConsolidateSession,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const result = await sessionGraphql<T>(session, query, variables)
  if (result.errors?.length || !result.data) {
    throw new Error(collectMessages(result.errors) || "Die Instanz hat keine Daten geliefert.")
  }
  return result.data
}

async function listPages(
  session: ConsolidateSession,
  load: (skip: number) => Promise<EntryRef[]>
): Promise<EntryRef[]> {
  const found: EntryRef[] = []
  const seen = new Set<string>()
  let skip = 0
  for (let page = 0; page < 200; page += 1) {
    const items = await load(skip)
    if (items.length === 0) break
    let added = 0
    for (const item of items) {
      if (!item.id || seen.has(item.id)) continue
      seen.add(item.id)
      found.push(item)
      added += 1
    }
    if (added === 0 || items.length < PAGE_SIZE) break
    skip += items.length
  }
  return found
}

async function listCollection(session: ConsolidateSession, collection: string): Promise<EntryRef[]> {
  const active = await listPages(session, async (skip) => {
    const data = await readData<{ dataEntries: { items: EntryRef[] | null } }>(session, LIST_ENTRIES, {
      collection,
      skip,
      take: PAGE_SIZE,
    })
    return data.dataEntries.items ?? []
  })
  const trashed = await listPages(session, async (skip) => {
    const data = await readData<{ dataEntriesInTrash: { items: EntryRef[] | null } }>(
      session,
      LIST_TRASH,
      { skip, take: PAGE_SIZE }
    )
    return (data.dataEntriesInTrash.items ?? []).filter((item) => item.dataCollection === collection)
  })
  const seen = new Set(active.map((item) => item.id))
  return [...active, ...trashed.filter((item) => !seen.has(item.id))]
}

const ENTRY_SECURITY = `
  query EntrySecurity($id: ID!) {
    dataEntry(id: $id) {
      security {
        entries {
          value
          key {
            __typename
            ... on User { id }
            ... on BasicRole { id }
            ... on Team { id }
            ... on SecurityGroup { id }
          }
        }
      }
    }
  }
`

const UPDATE_ENTRY_SECURITY = `
  mutation UpdateEntrySecurity($input: UpdateDataEntrySecurityInput!) {
    updateDataEntrySecurity(input: $input) {
      dataEntry { id }
      errors { ... on Error { message } }
    }
  }
`

const RESET_ENTRY_SECURITY = `
  mutation ResetEntrySecurity($input: ResetDataEntrySecurityInput!) {
    resetDataEntrySecurity(input: $input) {
      dataEntry { id }
      errors { ... on Error { message } }
    }
  }
`

function principalInput(key: { __typename?: string | null; id?: string | null } | null): {
  userId?: string
  roleId?: string
  groupId?: string
} {
  if (!key?.id || !key.__typename) return {}
  if (key.__typename === "User") return { userId: key.id }
  if (key.__typename === "SecurityGroup") return { groupId: key.id }
  if (key.__typename === "BasicRole" || key.__typename === "Team") return { roleId: key.id }
  return {}
}

async function grantDeletePermission(
  session: ConsolidateSession,
  adminId: string,
  id: string
): Promise<void> {
  const reset = await sessionGraphql<{
    resetDataEntrySecurity: { dataEntry: { id: string } | null; errors: PayloadError[] | null } | null
  }>(session, RESET_ENTRY_SECURITY, { input: { id } })
  const resetMessage = collectMessages(
    reset.errors,
    reset.data?.resetDataEntrySecurity?.errors
  )
  const current = await sessionGraphql<{
    dataEntry: {
      security: {
        entries: { value: string; key: { __typename?: string | null; id?: string | null } | null }[]
      } | null
    } | null
  }>(session, ENTRY_SECURITY, { id })
  const rules = (current.data?.dataEntry?.security?.entries ?? [])
    .map((entry) => ({ key: principalInput(entry.key), value: entry.value }))
    .filter((entry) => entry.key.userId || entry.key.roleId || entry.key.groupId)
  const existing = rules.find((entry) => entry.key.userId === adminId)
  if (existing) existing.value = "Manage"
  else rules.push({ key: { userId: adminId }, value: "Manage" })
  const updated = await sessionGraphql<{
    updateDataEntrySecurity: { dataEntry: { id: string } | null; errors: PayloadError[] | null } | null
  }>(session, UPDATE_ENTRY_SECURITY, { input: { id, securityRules: rules } })
  const updateMessage = collectMessages(
    updated.errors,
    updated.data?.updateDataEntrySecurity?.errors
  )
  if (!updated.data?.updateDataEntrySecurity?.dataEntry && !reset.data?.resetDataEntrySecurity?.dataEntry) {
    throw new Error(updateMessage || resetMessage || "Die Rechte konnten nicht gesetzt werden.")
  }
}

function isPermissionError(message: string): boolean {
  return /permission/i.test(message)
}

async function purgeEntries(
  session: ConsolidateSession,
  ids: string[],
  includeMonsterTaskChildren: boolean,
  adminId: string,
  names?: Map<string, string>
): Promise<{ removed: number; failedIds: string[]; detail: string }> {
  let removed = 0
  const failedIds: string[] = []
  const details: string[] = []

  const purgeBatch = async (batch: string[]) => {
    const trashed = await sessionGraphql<{
      moveToTrash: { errors: PayloadError[] | null } | null
    }>(session, MOVE_TO_TRASH, {
      input: { ids: batch, includeMonsterTaskChildren },
    })
    const deleted = await sessionGraphql<{
      deleteDataEntriesPermanently: { success: boolean | null; errors: PayloadError[] | null } | null
    }>(session, DELETE_PERMANENTLY, { input: { ids: batch } })
    const permanentMessage = collectMessages(
      deleted.errors,
      deleted.data?.deleteDataEntriesPermanently?.errors
    )
    const success =
      deleted.data?.deleteDataEntriesPermanently?.success === true && permanentMessage.length === 0
    const detail = collectMessages(
      [...(trashed.errors ?? []), ...(deleted.errors ?? [])],
      [...(trashed.data?.moveToTrash?.errors ?? []), ...(deleted.data?.deleteDataEntriesPermanently?.errors ?? [])]
    )
    return { success, detail }
  }

  for (const batch of chunks(ids, BATCH_SIZE)) {
    const first = await purgeBatch(batch)
    if (first.success) {
      removed += batch.length
      continue
    }
    for (const id of batch) {
      let result = await purgeBatch([id])
      if (!result.success && isPermissionError(result.detail)) {
        let grantNote = ""
        try {
          await grantDeletePermission(session, adminId, id)
        } catch (error) {
          grantNote = error instanceof Error ? error.message : "Die Rechte konnten nicht gesetzt werden."
        }
        result = await purgeBatch([id])
        if (!result.success && grantNote) {
          result = { ...result, detail: `${result.detail} ${grantNote}`.trim() }
        }
      }
      if (result.success) {
        removed += 1
        continue
      }
      failedIds.push(id)
      const name = names?.get(id)
      const text = name && result.detail ? `„${name}“: ${result.detail}` : result.detail
      if (text && details.length < 2) details.push(text)
    }
  }
  return { removed, failedIds, detail: details.join(" ") }
}

function findForm(forms: DataForm[], tokens: string[]): DataForm | undefined {
  const active = forms.filter((form) => !form.archived)
  return (
    active.find((form) => tokens.includes(form.dataCollection.toLowerCase())) ??
    active.find((form) => tokens.includes(form.displayName.toLowerCase()))
  )
}

async function wipeCollection(
  session: ConsolidateSession,
  emit: Emit,
  forms: DataForm[],
  label: string,
  tokens: string[],
  includeMonsterTaskChildren: boolean,
  adminId: string
): Promise<string[]> {
  const form = findForm(forms, tokens)
  if (!form) {
    emit({ type: "log", level: "error", message: `${label}: Formular wurde nicht gefunden.` })
    return []
  }
  const entries = await listCollection(session, form.dataCollection)
  const kept = entries.filter((entry) => entry.user?.id === adminId)
  const targets = entries.filter((entry) => entry.user?.id !== adminId)
  if (kept.length > 0) {
    const keptNames = kept.map((entry) => `„${entry.displayName}“`).join(", ")
    emit({
      type: "log",
      level: "info",
      message:
        kept.length === 1
          ? `${label}: ${keptNames} gehört zum verbundenen Service-User und bleibt bestehen.`
          : `${label}: ${keptNames} gehören zum verbundenen Service-User und bleiben bestehen.`,
    })
  }
  if (targets.length === 0) {
    if (kept.length === 0) emit({ type: "log", level: "info", message: `${label}: keine Einträge.` })
    return []
  }
  const result = await purgeEntries(
    session,
    targets.map((entry) => entry.id),
    includeMonsterTaskChildren,
    adminId,
    new Map(targets.map((entry) => [entry.id, entry.displayName]))
  )
  emit({
    type: "log",
    level: result.failedIds.length > 0 ? "error" : "success",
    message:
      result.failedIds.length > 0
        ? `${label}: ${result.removed} entfernt, ${result.failedIds.length} fehlgeschlagen. ${result.detail}`
        : `${label}: ${result.removed} entfernt.`,
  })
  return result.failedIds
}

async function wipeAppointments(session: ConsolidateSession, emit: Emit): Promise<void> {
  const calendars = await readData<{ calendars: { id: string }[] }>(session, CALENDARS)
  const calendarIds = calendars.calendars.map((calendar) => calendar.id)
  if (calendarIds.length === 0) {
    emit({ type: "log", level: "info", message: "Termine: keine Kalender." })
    return
  }
  const data = await readData<{
    calendarEventsInInterval: { events: { id: string; seriesMasterId: string }[] }
  }>(session, EVENTS, { calendars: calendarIds, start: INTERVAL_START, end: INTERVAL_END })
  const instanceIds: string[] = []
  const seen = new Set<string>()
  for (const event of data.calendarEventsInInterval.events) {
    const key = event.seriesMasterId || event.id
    if (seen.has(key)) continue
    seen.add(key)
    instanceIds.push(event.id)
  }
  if (instanceIds.length === 0) {
    emit({ type: "log", level: "info", message: "Termine: keine Einträge." })
    return
  }

  let removed = 0
  const failures: string[] = []
  for (const id of instanceIds) {
    const deleted = await sessionGraphql<{ deleteCalendarEvent: { success: boolean | null } | null }>(
      session,
      DELETE_EVENT,
      { input: { id, type: "All" } }
    )
    if (deleted.data?.deleteCalendarEvent?.success) {
      removed += 1
      continue
    }
    const message = collectMessages(deleted.errors) || "Termin konnte nicht gelöscht werden."
    if (failures.length < 3) failures.push(message)
  }
  emit({
    type: "log",
    level: failures.length > 0 ? "error" : "success",
    message:
      failures.length > 0
        ? `Termine: ${removed} entfernt, ${instanceIds.length - removed} fehlgeschlagen. ${failures.join(" ")}`
        : `Termine: ${removed} entfernt.`,
  })
}

async function wipeTypes(
  session: ConsolidateSession,
  emit: Emit,
  form: DataForm | undefined,
  label: string
): Promise<void> {
  if (!form) {
    emit({ type: "log", level: "error", message: `${label}: Formular wurde nicht gefunden.` })
    return
  }
  const deletable = form.types.filter((type) => !type.archived)
  let removed = 0
  const failures: string[] = []
  const kept: string[] = []
  for (const type of deletable) {
    const deleted = await sessionGraphql<{
      deleteDataType: { success: boolean | null; errors: PayloadError[] | null } | null
    }>(session, DELETE_TYPE, { input: { dataCollection: form.dataCollection, key: type.key } })
    const message = collectMessages(deleted.errors, deleted.data?.deleteDataType?.errors)
    if (deleted.data?.deleteDataType?.success && !message) {
      removed += 1
      continue
    }
    if (type.canBeDeleted) failures.push(`${type.displayName}: ${message || "Löschen wurde abgelehnt."}`)
    else kept.push(type.displayName)
  }
  const keptNote =
    kept.length > 0 ? ` ${kept.length} geschützte Typen bleiben bestehen: ${kept.join(", ")}.` : ""
  emit({
    type: "log",
    level: failures.length > 0 ? "error" : "success",
    message:
      failures.length > 0
        ? `${label}: ${removed} entfernt, ${failures.length} fehlgeschlagen.${keptNote} ${failures.join(" ")}`
        : `${label}: ${removed} entfernt.${keptNote}`,
  })
}

async function detachTeamMembers(session: ConsolidateSession, teamIds: Set<string>): Promise<void> {
  const groups = await Promise.all(
    (["Employee", "Service", "Restricted"] as const).map((userType) =>
      readData<{ allUsers: ListedUser[] }>(session, USERS, { userType })
    )
  )
  const seen = new Set<string>()
  for (const user of groups.flatMap((group) => group.allUsers)) {
    if (seen.has(user.id)) continue
    seen.add(user.id)
    const current = user.roles.map((role) => role.id)
    const next = current.filter((id) => !teamIds.has(id))
    if (next.length === current.length || next.length === 0) continue
    await sessionGraphql(session, UPDATE_USER, {
      input: {
        id: user.id,
        email: user.email,
        isActive: user.isActive,
        roles: next,
        type: user.type,
        ...(user.contact?.id ? { contactId: user.contact.id } : {}),
      },
    })
  }
}

async function wipeTeams(session: ConsolidateSession, emit: Emit): Promise<void> {
  const data = await readData<{
    activeTeams: {
      id: string
      name: string
      isSystemRole: boolean
      isDefault: boolean
      permissions: { key: string; value: boolean }[]
    }[]
  }>(session, TEAMS)
  const teams = data.activeTeams.filter((team) => !team.isSystemRole && !team.isDefault)
  if (teams.length === 0) {
    emit({ type: "log", level: "info", message: "Teams: keine Einträge." })
    return
  }

  await detachTeamMembers(session, new Set(teams.map((team) => team.id)))
  let removed = 0
  const failures: string[] = []
  for (const team of teams) {
    const updated = await sessionGraphql<{ updateRole: { role: { id: string } | null } | null }>(
      session,
      DEACTIVATE_TEAM,
      {
        input: {
          id: team.id,
          name: team.name,
          isDefault: false,
          isActive: false,
          permissions: team.permissions.map((permission) => ({
            key: permission.key,
            value: permission.value,
          })),
        },
      }
    )
    if (updated.data?.updateRole?.role?.id && !collectMessages(updated.errors)) {
      removed += 1
      continue
    }
    const message = collectMessages(updated.errors) || team.name
    if (failures.length < 3) failures.push(message)
  }
  emit({
    type: "log",
    level: failures.length > 0 ? "error" : "success",
    message:
      failures.length > 0
        ? `Teams: ${removed} deaktiviert, ${teams.length - removed} fehlgeschlagen. ${failures.join(" ")}`
        : `Teams: ${removed} deaktiviert.`,
  })
}

function nextRetiredLogin(email: string, taken: Set<string>): string {
  const own = email.trim().toLowerCase()
  let next = email.trim()
  if (!next.toLowerCase().startsWith("alt_")) next = `alt_${next}`
  for (let extra = 0; extra < 8 && taken.has(next.toLowerCase()) && next.toLowerCase() !== own; extra += 1) {
    next = `alt_${next}`
  }
  return next
}

let placeholderCount = 0

async function placeholderContactId(session: ConsolidateSession, user: ListedUser): Promise<string | undefined> {
  if (user.contact?.id) return user.contact.id
  const words = user.displayName.includes("@") ? [] : user.displayName.trim().split(/\s+/).filter(Boolean)
  placeholderCount += 1
  const created = await sessionGraphql<{ createContact: { contact: { id: string } | null } | null }>(
    session,
    CREATE_PLACEHOLDER_CONTACT,
    {
      input: {
        dataEntry: {
          firstName: words[0] || "Demo",
          lastName: words.slice(1).join(" ") || "Benutzer",
          email: [`platzhalter.${Date.now()}.${placeholderCount}@example.com`],
        },
      },
    }
  )
  return created.data?.createContact?.contact?.id
}

async function deactivateOtherUsers(session: ConsolidateSession, emit: Emit, adminId: string): Promise<void> {
  const groups = await Promise.all(
    (["Employee", "Service", "Restricted"] as const).map((userType) =>
      readData<{ allUsers: ListedUser[] }>(session, USERS, { userType })
    )
  )
  const users = groups.flatMap((group) => group.allUsers)
  const seen = new Set<string>()
  const targets = users.filter((user) => {
    if (user.id === adminId || seen.has(user.id)) return false
    seen.add(user.id)
    return true
  })
  const taken = new Set(users.map((user) => user.email.trim().toLowerCase()))
  let deactivated = 0
  for (const user of targets) {
    if (user.isSystem) continue
    if (!user.isActive && user.email.toLowerCase().includes("alt_")) {
      deactivated += 1
      continue
    }
    const email = nextRetiredLogin(user.email, taken)
    const contactId = await placeholderContactId(session, user)
    const updated = await sessionGraphql<{
      updateUser: {
        user: { id: string; isActive: boolean; email: string } | null
        errors: PayloadError[] | null
      } | null
    }>(session, UPDATE_USER, {
      input: {
        id: user.id,
        email,
        isActive: false,
        roles: user.roles.map((role) => role.id),
        type: user.type,
        ...(contactId ? { contactId } : {}),
      },
    })
    const message = collectMessages(updated.errors, updated.data?.updateUser?.errors)
    if (/at least one active administrator/i.test(message)) continue
    const updatedUser = updated.data?.updateUser?.user
    if (updatedUser && !updatedUser.isActive && updatedUser.email.toLowerCase() === email.toLowerCase() && !message) {
      taken.delete(user.email.trim().toLowerCase())
      taken.add(email.toLowerCase())
      deactivated += 1
    }
  }
  emit({
    type: "log",
    level: "success",
    message: `${deactivated} Benutzer deaktiviert`,
  })
}

export async function wipeDemoInstance(session: ConsolidateSession, emit: Emit): Promise<void> {
  const current = await readData<{ me: { user: { id: string } | null } | null }>(session, CURRENT_USER)
  const adminId = current.me?.user?.id
  if (!adminId) throw new Error("Der angemeldete Benutzer wurde nicht erkannt. Es wurde nichts gelöscht.")

  const formsResult = await readData<{ dataForms: DataForm[] }>(session, FORMS)
  const forms = formsResult.dataForms
  const steps = [
    "Aufgaben",
    "Termine",
    "Benutzer",
    "Kontakte",
    "Unternehmen",
    "Projekte",
    "Teams",
    "Aufgaben-Typen",
    "Projekt-Typen",
  ]
  const progress = (completed: number, label: string) =>
    emit({ type: "progress", completed, total: steps.length, label })

  progress(0, "Aufgaben werden entfernt")
  await wipeCollection(session, emit, forms, "Aufgaben", ["task", "tasks", "aufgabe", "aufgaben"], true, adminId)

  progress(1, "Termine werden entfernt")
  await wipeAppointments(session, emit)

  progress(2, "Weitere Benutzer werden deaktiviert")
  await deactivateOtherUsers(session, emit, adminId)

  progress(3, "Kontakte werden entfernt")
  const failedContacts = await wipeCollection(
    session,
    emit,
    forms,
    "Kontakte",
    ["contact", "contacts", "kontakt", "kontakte"],
    false,
    adminId
  )

  progress(4, "Unternehmen werden entfernt")
  const failedCompanies = await wipeCollection(
    session,
    emit,
    forms,
    "Unternehmen",
    ["company", "companies", "unternehmen", "firma", "firmen"],
    false,
    adminId
  )

  progress(5, "Projekte werden entfernt")
  await wipeCollection(session, emit, forms, "Projekte", ["project", "projects", "projekt", "projekte"], false, adminId)

  if (failedCompanies.length > 0) {
    const retry = await purgeEntries(session, failedCompanies, false, adminId)
    emit({
      type: "log",
      level: retry.failedIds.length > 0 ? "error" : "success",
      message:
        retry.failedIds.length > 0
          ? `Unternehmen, zweiter Durchlauf: ${retry.removed} entfernt, ${retry.failedIds.length} fehlgeschlagen. ${retry.detail}`
          : `Unternehmen, zweiter Durchlauf: ${retry.removed} entfernt.`,
    })
  }

  progress(6, "Teams werden entfernt")
  await wipeTeams(session, emit)

  progress(7, "Aufgaben-Typen werden entfernt")
  const typesAfterEntries = (await readData<{ dataForms: DataForm[] }>(session, FORMS)).dataForms
  await wipeTypes(
    session,
    emit,
    findForm(typesAfterEntries, ["task", "tasks", "aufgabe", "aufgaben"]),
    "Aufgaben-Typen"
  )

  progress(8, "Projekt-Typen werden entfernt")
  await wipeTypes(
    session,
    emit,
    findForm(typesAfterEntries, ["project", "projects", "projekt", "projekte"]),
    "Projekt-Typen"
  )

  if (failedContacts.length > 0) {
    const retry = await purgeEntries(session, failedContacts, false, adminId)
    emit({
      type: "log",
      level: retry.failedIds.length > 0 ? "error" : "success",
      message:
        retry.failedIds.length > 0
          ? `Kontakte, zweiter Durchlauf: ${retry.removed} entfernt, ${retry.failedIds.length} fehlgeschlagen. ${retry.detail}`
          : `Kontakte, zweiter Durchlauf: ${retry.removed} entfernt.`,
    })
  }

  progress(steps.length, "Instanz geleert")
}
