import { instanceAppUrl } from "@/lib/demo-plan"
import {
  saveSession,
  type ConsolidateSession,
} from "@/lib/session"
import type { TaskFieldDefinition } from "@/lib/task-fields"

export type GraphqlError = { message: string }

export type GraphqlResult<T> = {
  data?: T
  errors?: GraphqlError[]
  cookieHeader: string
}

type PayloadError = { message?: string | null } | null

export function mergeCookieHeader(current: string, setCookies: string[]): string {
  const jar = new Map<string, string>()
  for (const part of current.split(";")) {
    const trimmed = part.trim()
    const index = trimmed.indexOf("=")
    if (index > 0) jar.set(trimmed.slice(0, index), trimmed.slice(index + 1))
  }

  for (const raw of setCookies) {
    const pair = raw.split(";")[0]?.trim() ?? ""
    const index = pair.indexOf("=")
    if (index <= 0) continue
    const name = pair.slice(0, index)
    const value = pair.slice(index + 1)
    const expired = /max-age=0/i.test(raw) || value.length === 0
    if (expired) jar.delete(name)
    else jar.set(name, value)
  }

  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unbekannter Fehler"
}

export function collectMessages(
  errors?: GraphqlError[] | null,
  payloadErrors?: PayloadError[] | null
): string {
  const messages = [
    ...(errors ?? []).map((error) => error.message),
    ...(payloadErrors ?? []).map((error) => error?.message ?? ""),
  ].filter((message) => message.trim().length > 0)
  return messages.join("; ")
}

export async function graphqlRequest<T>(
  instanceUrl: string,
  cookieHeader: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<GraphqlResult<T>> {
  let response: Response
  try {
    response = await fetch(instanceUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    })
  } catch (error) {
    throw new Error(`Die Instanz ist nicht erreichbar. ${errorText(error)}`)
  }
  return readGraphqlResponse<T>(response, cookieHeader)
}

export async function graphqlUpload<T>(
  instanceUrl: string,
  cookieHeader: string,
  query: string,
  variables: Record<string, unknown>,
  files: { path: string; filename: string; contentType: string; body: Buffer }[]
): Promise<GraphqlResult<T>> {
  const map: Record<string, string[]> = {}
  const form = new FormData()
  files.forEach((file, index) => {
    map[String(index)] = [file.path]
  })
  form.append("operations", JSON.stringify({ query, variables }))
  form.append("map", JSON.stringify(map))
  files.forEach((file, index) => {
    form.append(
      String(index),
      new Blob([new Uint8Array(file.body)], { type: file.contentType }),
      file.filename
    )
  })
  let response: Response
  try {
    response = await fetch(instanceUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    })
  } catch (error) {
    throw new Error(`Die Instanz ist nicht erreichbar. ${errorText(error)}`)
  }
  return readGraphqlResponse<T>(response, cookieHeader)
}

async function readGraphqlResponse<T>(
  response: Response,
  cookieHeader: string
): Promise<GraphqlResult<T>> {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : []
  const nextCookie = mergeCookieHeader(cookieHeader, setCookies)
  const text = await response.text()

  let json: { data?: T; errors?: GraphqlError[] }
  try {
    json = text ? (JSON.parse(text) as { data?: T; errors?: GraphqlError[] }) : {}
  } catch {
    throw new Error(`Die Instanz hat kein JSON geliefert (HTTP ${response.status}).`)
  }

  if (!response.ok && !json.data && !json.errors) {
    throw new Error(`Die Instanz hat mit HTTP ${response.status} geantwortet.`)
  }

  return { data: json.data, errors: json.errors, cookieHeader: nextCookie }
}

export async function sessionGraphql<T>(
  session: ConsolidateSession,
  query: string,
  variables?: Record<string, unknown>
): Promise<GraphqlResult<T>> {
  const result = await graphqlRequest<T>(
    session.instanceUrl,
    session.cookieHeader,
    query,
    variables
  )
  if (result.cookieHeader !== session.cookieHeader) {
    session.cookieHeader = result.cookieHeader
    saveSession(session)
  }
  return result
}

async function sessionGraphqlUpload<T>(
  session: ConsolidateSession,
  query: string,
  variables: Record<string, unknown>,
  files: { path: string; filename: string; contentType: string; body: Buffer }[]
): Promise<GraphqlResult<T>> {
  const result = await graphqlUpload<T>(
    session.instanceUrl,
    session.cookieHeader,
    query,
    variables,
    files
  )
  if (result.cookieHeader !== session.cookieHeader) {
    session.cookieHeader = result.cookieHeader
    saveSession(session)
  }
  return result
}

export type SignInResult = {
  succeeded: boolean
  requiresTwoFactor: boolean
  isLockedOut: boolean
  requiresPasswordChange: boolean
}

export type MeUser = {
  id: string
  email: string
  displayName: string
}

export type MePayload = {
  permissions: {
    editUsers: boolean
    dataForms: boolean
    databaseAdministration: boolean
    calendarAccess?: boolean
  }
  user: MeUser
}

const AUTHENTICATE = `
  mutation Authenticate($input: AuthenticateInput!) {
    authenticate(input: $input) {
      signInResult {
        succeeded
        requiresTwoFactor
        isLockedOut
        requiresPasswordChange
      }
    }
  }
`

const ME = `
  query Me {
    me {
      permissions {
        editUsers
        dataForms
        databaseAdministration
      }
      user {
        id
        email
        displayName
      }
    }
  }
`

export async function authenticate(
  instanceUrl: string,
  username: string,
  password: string
): Promise<{ signIn: SignInResult; cookieHeader: string; me: MePayload }> {
  const auth = await graphqlRequest<{
    authenticate: { signInResult: SignInResult | null }
  }>(instanceUrl, "", AUTHENTICATE, { input: { username, password } })

  const signIn = auth.data?.authenticate?.signInResult
  const authMessage = collectMessages(auth.errors)
  if (!signIn) {
    throw new Error(authMessage || "Die Anmeldung hat kein Ergebnis geliefert.")
  }
  if (signIn.requiresTwoFactor) {
    throw new Error("Zwei-Faktor-Anmeldung wird von diesem Generator nicht unterstützt.")
  }
  if (signIn.isLockedOut) {
    throw new Error("Das Konto ist gesperrt.")
  }
  if (signIn.requiresPasswordChange) {
    throw new Error("Das Passwort muss zuerst in Consolidate geändert werden.")
  }
  if (!signIn.succeeded) {
    throw new Error(authMessage || "Anmeldung fehlgeschlagen. Benutzername oder Passwort prüfen.")
  }
  if (!auth.cookieHeader) {
    throw new Error("Die Instanz hat kein Sitzungs-Cookie gesetzt.")
  }

  const meResult = await graphqlRequest<{ me: MePayload }>(
    instanceUrl,
    auth.cookieHeader,
    ME
  )
  const me = meResult.data?.me
  if (!me?.user) {
    throw new Error(
      collectMessages(meResult.errors) ||
        "Die Sitzung wurde nicht erkannt. Die Instanz hat die Anmeldung nicht bestätigt."
    )
  }
  if (!me.permissions.editUsers || !me.permissions.dataForms) {
    throw new Error(
      "Dieses Konto darf keine Benutzer oder Formulartypen anlegen. Bitte mit einem Administrator anmelden."
    )
  }

  return {
    signIn,
    cookieHeader: meResult.cookieHeader || auth.cookieHeader,
    me,
  }
}

export function buildSession(input: {
  instanceUrl: string
  username: string
  cookieHeader: string
  me: MePayload
}): ConsolidateSession {
  return {
    id: crypto.randomUUID(),
    connected: true,
    instanceUrl: input.instanceUrl,
    appUrl: instanceAppUrl(input.instanceUrl),
    username: input.username,
    displayName: input.me.user.displayName,
    email: input.me.user.email,
    isAdmin: input.me.permissions.editUsers && input.me.permissions.dataForms,
    cookieHeader: input.cookieHeader,
  }
}

export type DataFormInfo = {
  dataCollection: string
  displayName: string
  archived: boolean
  isSystemTemplate: boolean
  allowMultipleTypes: boolean
  types: { key: string; displayName: string; archived: boolean }[]
}

export type ImportContext = {
  me: MePayload & { id: string }
  roles: { id: string; name: string; isDefault: boolean; isSystemRole: boolean }[]
  taskStatuses: {
    id: string
    name: string
    category: "Todo" | "InProgress" | "Done"
    availableInTypes: string[]
  }[]
  dataForms: DataFormInfo[]
  calendars: {
    id: string
    name: string
    isDefaultCalendar: boolean
    owner: { id: string }
  }[]
}

const IMPORT_CONTEXT = `
  query ImportContext {
    me {
      id
      permissions {
        editUsers
        dataForms
        databaseAdministration
        calendarAccess
      }
      user { id email displayName }
    }
    roles { id name isDefault isSystemRole }
    taskStatuses { id name category availableInTypes }
    dataForms(returnAll: true) {
      dataCollection
      displayName
      archived
      isSystemTemplate
      allowMultipleTypes
      types { key displayName archived }
    }
    calendars {
      id
      name
      isDefaultCalendar
      owner { id }
    }
  }
`

export async function loadImportContext(
  session: ConsolidateSession
): Promise<ImportContext> {
  const result = await sessionGraphql<ImportContext>(session, IMPORT_CONTEXT)
  if (!result.data?.me || !result.data.dataForms) {
    throw new Error(collectMessages(result.errors) || "Der Instanz-Kontext konnte nicht geladen werden.")
  }
  return result.data
}

const DATA_TYPE_COLORS = [
  "Teal",
  "Green",
  "Yellow",
  "Orange",
  "Red",
  "Purple",
  "Blue",
  "Sky",
  "Amber",
  "Rose",
] as const

const CREATE_DATA_TYPE = `
  mutation CreateDataType($input: CreateDataTypeInput!) {
    createDataType(input: $input) {
      dataType { key displayName }
      errors { ... on Error { message } }
    }
  }
`

export async function createDataType(
  session: ConsolidateSession,
  input: {
    dataCollection: string
    displayName: string
    colorIndex: number
    fields?: TaskFieldDefinition[]
  }
): Promise<{ key: string; displayName: string }> {
  const result = await sessionGraphql<{
    createDataType: {
      dataType: { key: string; displayName: string } | null
      errors: PayloadError[] | null
    }
  }>(session, CREATE_DATA_TYPE, {
    input: {
      dataCollection: input.dataCollection,
      displayName: input.displayName,
      color: DATA_TYPE_COLORS[input.colorIndex % DATA_TYPE_COLORS.length],
      level: "Task",
      additionalFields: (input.fields ?? []).map(toAdditionalField),
    },
  })
  const payload = result.data?.createDataType
  const message = collectMessages(result.errors, payload?.errors)
  if (!payload?.dataType) throw new Error(message || "Datentyp wurde nicht angelegt.")
  return payload.dataType
}

function toAdditionalField(field: TaskFieldDefinition) {
  return {
    value: {
      key: field.key,
      label: field.label,
      required: true,
      valueType: field.valueType,
      selectionType: "Single",
      searchable:
        field.valueType === "Text" ||
        field.valueType === "Number" ||
        field.valueType === "ComboBox",
      archived: false,
      validators: [],
      requiresManagePermissions: false,
      section: "Main",
      size: "Half",
      ...(field.helpText ? { helpText: field.helpText } : {}),
      ...(field.valueType === "Number" ? { maxDecimals: 1 } : {}),
      ...(field.valueType === "ComboBox" ? { comboBoxOptions: field.options } : {}),
    },
  }
}

const TYPE_ENUMS = `
  query TypeEnums {
    projectTypes: __type(name: "ProjectTypes") {
      enumValues { name description }
    }
    taskTypes: __type(name: "TaskTypes") {
      enumValues { name description }
    }
  }
`

export type EnumValue = { name: string; description?: string | null }

export async function loadTypeEnums(session: ConsolidateSession): Promise<{
  projectTypes: EnumValue[]
  taskTypes: EnumValue[]
}> {
  const result = await sessionGraphql<{
    projectTypes: { enumValues: EnumValue[] } | null
    taskTypes: { enumValues: EnumValue[] } | null
  }>(session, TYPE_ENUMS)
  return {
    projectTypes: result.data?.projectTypes?.enumValues ?? [],
    taskTypes: result.data?.taskTypes?.enumValues ?? [],
  }
}

const TASK_INPUT_FIELDS = `
  query TaskInputFields {
    __type(name: "TaskInput") {
      inputFields { name }
    }
  }
`

export async function loadTaskInputFieldNames(
  session: ConsolidateSession
): Promise<Set<string>> {
  const result = await sessionGraphql<{
    __type: { inputFields: { name: string }[] } | null
  }>(session, TASK_INPUT_FIELDS)
  return new Set(result.data?.__type?.inputFields.map((field) => field.name) ?? [])
}

export function matchEnumValue(
  values: EnumValue[],
  key: string,
  displayName: string
): string | null {
  const normalizedKey = key.replace(/-/g, "").toLowerCase()
  const byKey = values.find((value) => {
    const description = (value.description ?? "").replace(/-/g, "").toLowerCase()
    return description.length > 0 && description === normalizedKey
  })
  if (byKey) return byKey.name
  const sanitized = displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const byName = values.find(
    (value) => value.name.toLowerCase() === sanitized.toLowerCase()
  )
  return byName?.name ?? null
}

const CREATE_ROLE = `
  mutation CreateRole($input: CreateRoleInput!) {
    createRole(input: $input) {
      role { id name }
    }
  }
`

const CONVERT_ROLE = `
  mutation ConvertRoleToTeam($input: ConvertRoleToTeamInput!) {
    convertRoleToTeam(input: $input) {
      role { id name }
    }
  }
`

export async function createTeam(
  session: ConsolidateSession,
  name: string,
  baseRoleId?: string
): Promise<{ id: string; name: string }> {
  const created = await sessionGraphql<{
    createRole: { role: { id: string; name: string } | null }
  }>(session, CREATE_ROLE, {
    input: { name, ...(baseRoleId ? { baseRoleId } : {}) },
  })
  const role = created.data?.createRole?.role
  if (!role) {
    throw new Error(collectMessages(created.errors) || `Rolle "${name}" wurde nicht angelegt.`)
  }

  const converted = await sessionGraphql<{
    convertRoleToTeam: { role: { id: string; name: string } | null }
  }>(session, CONVERT_ROLE, { input: { id: role.id } })
  const team = converted.data?.convertRoleToTeam?.role
  if (!team) {
    throw new Error(
      collectMessages(converted.errors) || `Rolle "${name}" konnte nicht in ein Team umgewandelt werden.`
    )
  }
  return team
}

const CREATE_COMPANY = `
  mutation CreateCompany($input: CreateCompanyInput!) {
    createCompany(input: $input) {
      company { id displayName }
    }
  }
`

export async function createCompanyRecord(
  session: ConsolidateSession,
  company: {
    name: string
    email: string
    phone: string
    street: string
    zipCode: string
    city: string
    country: string
    note: string
  }
): Promise<{ id: string; displayName: string }> {
  const address = {
    ...(company.street ? { street: company.street } : {}),
    ...(company.zipCode ? { zipCode: company.zipCode } : {}),
    ...(company.city ? { city: company.city } : {}),
    ...(company.country ? { country: company.country } : {}),
  }
  const withAddress = {
    name: company.name,
    email: [company.email],
    ...(company.phone ? { phoneNumber: [company.phone] } : {}),
    ...(Object.keys(address).length > 0 ? { address } : {}),
    ...(company.note ? { notes: { htmlText: `<p>${escapeHtml(company.note)}</p>` } } : {}),
  }
  const nameOnly = {
    name: company.name,
    email: [company.email],
    ...(company.phone ? { phoneNumber: [company.phone] } : {}),
  }
  let lastMessage = "Unternehmen wurde nicht angelegt."
  for (const dataEntry of [withAddress, nameOnly]) {
    const result = await sessionGraphql<{
      createCompany: { company: { id: string; displayName: string } | null }
    }>(session, CREATE_COMPANY, { input: { dataEntry } })
    const created = result.data?.createCompany?.company
    if (created) return created
    lastMessage = collectMessages(result.errors) || lastMessage
  }
  throw new Error(lastMessage)
}

const CREATE_CONTACT = `
  mutation CreateContact($input: CreateContactInput!) {
    createContact(input: $input) {
      contact { id displayName }
    }
  }
`

export async function createContact(
  session: ConsolidateSession,
  person: {
    firstName: string
    lastName: string
    email: string
    position?: string
    phone?: string
    department?: string
    companyId?: string
  }
): Promise<{ id: string; displayName: string }> {
  const affiliation = person.companyId
    ? [
        {
          companyId: person.companyId,
          ...(person.position ? { position: person.position } : {}),
          ...(person.department ? { department: person.department } : {}),
          includeInCrossReferences: true,
        },
      ]
    : undefined
  const attempts = [
    {
      firstName: person.firstName,
      lastName: person.lastName,
      email: [person.email],
      ...(person.position ? { position: person.position } : {}),
      ...(person.phone ? { phoneNumber: [person.phone] } : {}),
      ...(affiliation ? { company: affiliation } : {}),
    },
    {
      firstName: person.firstName,
      lastName: person.lastName,
      email: [person.email],
      ...(person.position ? { position: person.position } : {}),
      ...(affiliation ? { company: affiliation } : {}),
    },
    {
      firstName: person.firstName,
      lastName: person.lastName,
      email: [person.email],
      ...(person.position ? { position: person.position } : {}),
    },
    {
      firstName: person.firstName,
      lastName: person.lastName,
      email: [person.email],
    },
  ]

  let lastMessage = "Kontakt wurde nicht angelegt."
  for (const dataEntry of attempts) {
    const result = await sessionGraphql<{
      createContact: { contact: { id: string; displayName: string } | null }
    }>(session, CREATE_CONTACT, { input: { dataEntry } })
    const contact = result.data?.createContact?.contact
    if (contact) return contact
    lastMessage = collectMessages(result.errors) || lastMessage
  }
  throw new Error(lastMessage)
}

const CREATE_USER = `
  mutation CreateUser($input: CreateUserInput!) {
    createUser(input: $input) {
      user { id email displayName firstName lastName }
      errors { ... on Error { message } }
    }
  }
`

export async function createEmployee(
  session: ConsolidateSession,
  input: {
    email: string
    password: string
    contactId?: string
    roleIds: string[]
  }
): Promise<{ id: string; email: string; displayName: string }> {
  const result = await sessionGraphql<{
    createUser: {
      user: { id: string; email: string; displayName: string } | null
      errors: PayloadError[] | null
    }
  }>(session, CREATE_USER, {
    input: {
      email: input.email,
      password: input.password,
      isActive: true,
      requirePasswordChange: false,
      roles: input.roleIds,
      type: "Employee",
      ...(input.contactId ? { contactId: input.contactId } : {}),
    },
  })
  const user = result.data?.createUser?.user
  const message = collectMessages(result.errors, result.data?.createUser?.errors)
  if (!user) throw new Error(message || "Mitarbeiter wurde nicht angelegt.")
  return user
}

const CREATE_PROJECT = `
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      project { id displayName }
    }
  }
`

export async function createProject(
  session: ConsolidateSession,
  input: {
    name: string
    summary: string
    startDate: string
    endDate: string
    projectManagerId?: string
    responsibleId?: string
    typeName?: string
  }
): Promise<{ id: string; displayName: string; linkedType: boolean }> {
  const dataEntry = {
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    description: { htmlText: `<p>${escapeHtml(input.summary)}</p>` },
    ...(input.projectManagerId ? { projectManager: input.projectManagerId } : {}),
    ...(input.responsibleId ? { responsible: input.responsibleId } : {}),
  }

  const first = await sessionGraphql<{
    createProject: { project: { id: string; displayName: string } | null }
  }>(session, CREATE_PROJECT, {
    input: {
      dataEntry,
      ...(input.typeName ? { type: input.typeName } : {}),
    },
  })
  const created = first.data?.createProject?.project
  if (created) return { ...created, linkedType: Boolean(input.typeName) }

  const message = collectMessages(first.errors)
  if (input.typeName && /type|enum|ProjectTypes/i.test(message)) {
    const retry = await sessionGraphql<{
      createProject: { project: { id: string; displayName: string } | null }
    }>(session, CREATE_PROJECT, { input: { dataEntry } })
    const project = retry.data?.createProject?.project
    if (project) return { ...project, linkedType: false }
    throw new Error(collectMessages(retry.errors) || message)
  }
  throw new Error(message || "Projekt wurde nicht angelegt.")
}

const CREATE_TASK = `
  mutation CreateTask($input: CreateTaskInput!) {
    createTask(input: $input) {
      task { id displayName changeVector }
    }
  }
`

export async function createTaskRecord(
  session: ConsolidateSession,
  input: {
    subject: string
    description: string
    statusId: string
    priority: string
    projectId?: string
    responsibleId?: string
    startDate: string
    dueDate: string
    typeName?: string
    extraFields?: Record<string, string | number | boolean>
  }
): Promise<{ id: string; displayName: string; changeVector?: string | null; linkedType: boolean; fieldsApplied: boolean }> {
  const baseEntry = {
    subject: input.subject,
    status: input.statusId,
    priority: input.priority,
    startDate: input.startDate,
    dueDate: input.dueDate,
    description: { htmlText: `<p>${escapeHtml(input.description)}</p>` },
    ...(input.projectId ? { project: input.projectId } : {}),
    ...(input.responsibleId ? { responsible: input.responsibleId } : {}),
  }
  const extra = input.extraFields ?? {}
  const hasExtra = Object.keys(extra).length > 0

  const post = (dataEntry: Record<string, unknown>, typeName?: string) =>
    sessionGraphql<{
      createTask: { task: { id: string; displayName: string; changeVector?: string | null } | null }
    }>(session, CREATE_TASK, {
      input: {
        dataEntry,
        ...(typeName ? { type: typeName } : {}),
      },
    })

  const first = await post({ ...baseEntry, ...extra }, input.typeName)
  const created = first.data?.createTask?.task
  if (created) return { ...created, linkedType: Boolean(input.typeName), fieldsApplied: hasExtra }

  if (hasExtra) {
    const withoutFields = await post(baseEntry, input.typeName)
    const task = withoutFields.data?.createTask?.task
    if (task) return { ...task, linkedType: Boolean(input.typeName), fieldsApplied: false }
  }

  const message = collectMessages(first.errors)
  if (input.typeName && /type|enum|TaskTypes/i.test(message)) {
    const retry = await post(baseEntry)
    const task = retry.data?.createTask?.task
    if (task) return { ...task, linkedType: false, fieldsApplied: false }
    throw new Error(collectMessages(retry.errors) || message)
  }
  throw new Error(message || "Aufgabe wurde nicht angelegt.")
}

const TASK_FILE_STATE = `
  id
  changeVector
  attachments { id name isVersioned versionCount }
`

const UPDATE_TASK_FILE = `
  mutation UpdateTaskFile($input: UpdateTaskInput!) {
    updateTask(input: $input) {
      task { ${TASK_FILE_STATE} }
    }
  }
`

const CREATE_VERSION_HISTORY = `
  mutation CreateVersionHistory($input: CreateVersionHistoryInput!) {
    createVersionHistory(input: $input) {
      dataEntry { ... on Task { ${TASK_FILE_STATE} } }
      errors { ... on Error { message } }
    }
  }
`

const CREATE_DRAFT = `
  mutation CreateDraft($input: CreateDraftInput!) {
    createDraft(input: $input) {
      dataEntry { ... on Task { ${TASK_FILE_STATE} } }
      errors { ... on Error { message } }
    }
  }
`

const APPROVE_DRAFT = `
  mutation ApproveDraft($input: ApproveDraftInput!) {
    approveDraft(input: $input) {
      dataEntry { ... on Task { ${TASK_FILE_STATE} } }
      errors { ... on Error { message } }
    }
  }
`

type TaskFileState = {
  id: string
  changeVector?: string | null
  attachments: { id: string; name: string; isVersioned: boolean; versionCount: number }[]
}

export async function attachTaskFile(
  session: ConsolidateSession,
  input: {
    taskId: string
    changeVector?: string | null
    fileName: string
    contentType: string
    versions: Buffer[]
  }
): Promise<{ versionCount: number }> {
  if (input.versions.length === 0) throw new Error("Die Datei hat keinen Inhalt.")
  const uploaded = await sessionGraphqlUpload<{
    updateTask: { task: TaskFileState | null }
  }>(
    session,
    UPDATE_TASK_FILE,
    {
      input: {
        id: input.taskId,
        ...(input.changeVector ? { changeVector: input.changeVector } : {}),
        newAttachments: [{ file: null }],
      },
    },
    [
      {
        path: "variables.input.newAttachments.0.file",
        filename: input.fileName,
        contentType: input.contentType,
        body: input.versions[0],
      },
    ]
  )
  const task = uploaded.data?.updateTask?.task
  const attachment = task?.attachments?.find((item) => item.name === input.fileName) ?? task?.attachments?.at(-1)
  if (!task || !attachment) {
    throw new Error(collectMessages(uploaded.errors) || "Die Datei wurde nicht angehängt.")
  }
  if (input.versions.length === 1) return { versionCount: attachment.versionCount || 1 }

  let changeVector = task.changeVector ?? undefined
  const history = await sessionGraphql<{
    createVersionHistory: { dataEntry: TaskFileState | null; errors: PayloadError[] | null }
  }>(session, CREATE_VERSION_HISTORY, {
    input: { dataEntryId: input.taskId, attachmentId: attachment.id },
  })
  const historyMessage = collectMessages(history.errors, history.data?.createVersionHistory?.errors)
  if (!history.data?.createVersionHistory?.dataEntry && !/already exists|bereits/i.test(historyMessage)) {
    throw new Error(historyMessage || "Die Versionshistorie wurde nicht angelegt.")
  }
  changeVector = history.data?.createVersionHistory?.dataEntry?.changeVector ?? changeVector

  for (let index = 1; index < input.versions.length; index += 1) {
    const draft = await sessionGraphqlUpload<{
      createDraft: { dataEntry: TaskFileState | null; errors: PayloadError[] | null }
    }>(
      session,
      CREATE_DRAFT,
      {
        input: {
          dataEntryId: input.taskId,
          attachmentId: attachment.id,
          newFile: null,
          ...(changeVector ? { changeVector } : {}),
        },
      },
      [
        {
          path: "variables.input.newFile",
          filename: input.fileName,
          contentType: input.contentType,
          body: input.versions[index],
        },
      ]
    )
    const draftMessage = collectMessages(draft.errors, draft.data?.createDraft?.errors)
    if (!draft.data?.createDraft?.dataEntry) {
      throw new Error(draftMessage || `Version ${index + 1} wurde nicht angelegt.`)
    }
    changeVector = draft.data.createDraft.dataEntry.changeVector ?? changeVector
    const approved = await sessionGraphql<{
      approveDraft: { dataEntry: TaskFileState | null; errors: PayloadError[] | null }
    }>(session, APPROVE_DRAFT, {
      input: {
        dataEntryId: input.taskId,
        attachmentId: attachment.id,
        comment: `Version ${index + 1}`,
        ...(changeVector ? { changeVector } : {}),
      },
    })
    const approvedMessage = collectMessages(approved.errors, approved.data?.approveDraft?.errors)
    if (!approved.data?.approveDraft?.dataEntry) {
      throw new Error(approvedMessage || `Version ${index + 1} wurde nicht freigegeben.`)
    }
    changeVector = approved.data.approveDraft.dataEntry.changeVector ?? changeVector
    const count = approved.data.approveDraft.dataEntry.attachments?.find(
      (item) => item.id === attachment.id
    )?.versionCount
    if (index === input.versions.length - 1) return { versionCount: count || input.versions.length }
  }

  return { versionCount: input.versions.length }
}

const CREATE_STATUS = `
  mutation CreateTaskStatus($input: CreateTaskStatusInput!) {
    createTaskStatus(input: $input) {
      taskStatus { id name category }
    }
  }
`

export async function createTaskStatus(
  session: ConsolidateSession,
  input: {
    name: string
    category: "Todo" | "InProgress" | "Done"
    availableInTypes: string[]
    afterStatusId?: string
  }
): Promise<{ id: string; name: string; category: "Todo" | "InProgress" | "Done" }> {
  const result = await sessionGraphql<{
    createTaskStatus: {
      taskStatus: { id: string; name: string; category: "Todo" | "InProgress" | "Done" } | null
    }
  }>(session, CREATE_STATUS, {
    input: {
      name: input.name,
      category: input.category,
      availableInTypes: input.availableInTypes,
      ...(input.afterStatusId ? { afterStatusId: input.afterStatusId } : {}),
    },
  })
  const status = result.data?.createTaskStatus?.taskStatus
  if (!status) {
    throw new Error(collectMessages(result.errors) || `Status "${input.name}" wurde nicht angelegt.`)
  }
  return status
}

const CREATE_CALENDAR = `
  mutation CreateCalendar($input: CreateCalendarInput!) {
    createCalendar(input: $input) {
      calendar { id name }
    }
  }
`

export async function createCalendar(
  session: ConsolidateSession,
  name: string
): Promise<{ id: string; name: string }> {
  const result = await sessionGraphql<{
    createCalendar: { calendar: { id: string; name: string } | null }
  }>(session, CREATE_CALENDAR, { input: { name, color: "Blue" } })
  const calendar = result.data?.createCalendar?.calendar
  if (!calendar) {
    throw new Error(collectMessages(result.errors) || "Kalender wurde nicht angelegt.")
  }
  return calendar
}

const CREATE_EVENT = `
  mutation CreateCalendarEvent($input: CreateCalendarEventInput!) {
    createCalendarEvent(input: $input) {
      calendarEventInstance {
        id
        title
        appointment { id }
      }
    }
  }
`

export async function createCalendarEvent(
  session: ConsolidateSession,
  input: {
    calendarId: string
    title: string
    location: string
    description: string
    startDate: string
    startTime: string
    endDate: string
    endTime: string
    attendeeIds: string[]
  }
): Promise<{ id: string; title: string; appointmentId: string | null }> {
  const result = await sessionGraphql<{
    createCalendarEvent: {
      calendarEventInstance: {
        id: string
        title: string
        appointment: { id: string } | null
      } | null
    }
  }>(session, CREATE_EVENT, {
    input: {
      calendarId: input.calendarId,
      title: input.title,
      location: input.location,
      visibility: "Public",
      availability: "Busy",
      description: { htmlText: `<p>${escapeHtml(input.description)}</p>` },
      timeSpan: {
        isAllDay: false,
        start: {
          date: input.startDate,
          time: input.startTime,
          timeZone: "Europe/Berlin",
        },
        end: {
          date: input.endDate,
          time: input.endTime,
          timeZone: "Europe/Berlin",
        },
      },
      attendees: input.attendeeIds.map((userId) => ({
        role: "Required",
        participant: { userId },
      })),
    },
  })
  const event = result.data?.createCalendarEvent?.calendarEventInstance
  if (!event) {
    throw new Error(collectMessages(result.errors) || "Termin wurde nicht angelegt.")
  }
  return {
    id: event.id,
    title: event.title,
    appointmentId: event.appointment?.id ?? null,
  }
}

const ADD_ASSOCIATION = `
  mutation AddAssociation($input: AddAssociationInput!) {
    addAssociation(input: $input) {
      errors { ... on Error { message } }
    }
  }
`

export async function associateRecords(
  session: ConsolidateSession,
  entityId: string,
  associationId: string
): Promise<void> {
  const result = await sessionGraphql<{
    addAssociation: { errors: PayloadError[] | null } | null
  }>(session, ADD_ASSOCIATION, {
    input: { entity: entityId, association: associationId },
  })
  const message = collectMessages(result.errors, result.data?.addAssociation?.errors)
  if (message) throw new Error(message)
  if (!result.data?.addAssociation) {
    throw new Error("Die Verknüpfung wurde nicht gespeichert.")
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}
