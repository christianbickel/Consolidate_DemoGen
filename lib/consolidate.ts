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
  variables?: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<GraphqlResult<T>> {
  let response: Response
  try {
    response = await fetch(instanceUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "accept-language": "de",
        "x-time-zone": "Europe/Berlin",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...headers,
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
  files: { path: string; filename: string; contentType: string; body: Buffer }[],
  headers?: Record<string, string>
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
        "accept-language": "de",
        "x-time-zone": "Europe/Berlin",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...headers,
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
  variables?: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<GraphqlResult<T>> {
  const result = await graphqlRequest<T>(
    session.instanceUrl,
    session.cookieHeader,
    query,
    variables,
    { ...apiKeyHeader(session), ...headers }
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
    files,
    apiKeyHeader(session)
  )
  if (result.cookieHeader !== session.cookieHeader) {
    session.cookieHeader = result.cookieHeader
    saveSession(session)
  }
  return result
}

export type MeUser = {
  id: string
  email: string
  displayName: string
  type?: "Employee" | "Service" | "Restricted"
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

function apiKeyHeader(session: ConsolidateSession): Record<string, string> {
  return { "X-API-Key": session.apiKey }
}

export async function authenticate(
  instanceUrl: string,
  apiKey: string
): Promise<{ cookieHeader: string; me: MePayload }> {
  const key = apiKey.trim()
  let meResult: GraphqlResult<{ me: MePayload }>
  try {
    meResult = await graphqlRequest<{ me: MePayload }>(instanceUrl, "", ME, undefined, {
      "X-API-Key": key,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/\b401\b|\b403\b/.test(message)) {
      throw new Error("Der API-Schlüssel wurde abgelehnt. Schlüssel und Instanz-URL prüfen.")
    }
    throw error
  }
  const authMessage = collectMessages(meResult.errors)
  if (/not authorized|unauthenticated|api key/i.test(authMessage)) {
    throw new Error("Der API-Schlüssel wurde abgelehnt. Schlüssel und Instanz-URL prüfen.")
  }
  const me = meResult.data?.me
  if (!me?.user) {
    throw new Error(authMessage || "Der API-Schlüssel wurde abgelehnt. Schlüssel und Instanz-URL prüfen.")
  }
  if (!me.permissions.editUsers || !me.permissions.dataForms) {
    throw new Error(
      "Der Service-User dieses Schlüssels darf keine Benutzer oder Formulartypen anlegen."
    )
  }

  return {
    cookieHeader: meResult.cookieHeader,
    me,
  }
}

export function buildSession(input: {
  instanceUrl: string
  apiKey: string
  cookieHeader: string
  me: MePayload
}): ConsolidateSession {
  return {
    id: crypto.randomUUID(),
    connected: true,
    instanceUrl: input.instanceUrl,
    appUrl: instanceAppUrl(input.instanceUrl),
    username: input.me.user.email || input.me.user.displayName,
    displayName: input.me.user.displayName,
    email: input.me.user.email,
    isAdmin: input.me.permissions.editUsers && input.me.permissions.dataForms,
    apiKey: input.apiKey.trim(),
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
      user { id email displayName type }
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

const createDataTypeArgNames = new Map<string, Set<string>>()

async function createDataTypeArguments(session: ConsolidateSession): Promise<Set<string>> {
  const cached = createDataTypeArgNames.get(session.instanceUrl)
  if (cached) return cached
  const result = await sessionGraphql<{
    __type: { fields: { name: string; args: { name: string }[] }[] } | null
  }>(session, `query CreateDataTypeArguments { __type(name: "Mutation") { fields { name args { name } } } }`)
  const names = new Set(
    result.data?.__type?.fields.find((field) => field.name === "createDataType")?.args.map((arg) => arg.name) ??
      []
  )
  createDataTypeArgNames.set(session.instanceUrl, names)
  return names
}

const PRIME_DATA_FORM = `
  query PrimeDataForm($dataCollection: DataCollection!) {
    dataForm(dataCollection: $dataCollection) { id dataCollection }
  }
`

const CREATE_DATA_TYPE = `
  mutation CreateDataType($input: CreateDataTypeInput!) {
    createDataType(input: $input) {
      dataType { key }
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
  const primed = await sessionGraphql<{
    dataForm: { id: string; dataCollection: string } | null
  }>(session, PRIME_DATA_FORM, { dataCollection: input.dataCollection })
  const dataCollection = primed.data?.dataForm?.dataCollection || input.dataCollection
  if (!primed.data?.dataForm) {
    throw new Error(
      collectMessages(primed.errors) || `Formular „${input.dataCollection}“ wurde nicht gefunden.`
    )
  }

  const mutationArguments = await createDataTypeArguments(session)
  const variables: Record<string, unknown> = {
    input: {
      dataCollection,
      displayName: input.displayName,
      color: DATA_TYPE_COLORS[input.colorIndex % DATA_TYPE_COLORS.length],
      level: "Task",
      additionalFields: (input.fields ?? []).map(toAdditionalField),
    },
  }
  const passesCollection = mutationArguments.has("dataCollection")
  if (passesCollection) variables.dataCollection = dataCollection
  const mutation = passesCollection
    ? `mutation CreateDataType($input: CreateDataTypeInput!, $dataCollection: DataCollection!) {
        createDataType(input: $input, dataCollection: $dataCollection) {
          dataType { key }
          errors { ... on Error { message } }
        }
      }`
    : CREATE_DATA_TYPE

  const result = await sessionGraphql<{
    createDataType: {
      dataType: { key: string } | null
      errors: PayloadError[] | null
    }
  }>(session, mutation, variables)
  const payload = result.data?.createDataType
  const message = collectMessages(result.errors, payload?.errors)
  if (!payload?.dataType) throw new Error(message || "Datentyp wurde nicht angelegt.")
  return { key: payload.dataType.key, displayName: input.displayName }
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
      allowedValues: [],
      security: [],
      requiresManagePermissions: false,
      section: "Main",
      size: "Half",
      ...(field.helpText ? { helpText: field.helpText } : {}),
      ...(field.valueType === "Number" ? { maxDecimals: 1 } : {}),
      ...(field.valueType === "ComboBox" ? { comboBoxOptions: field.options } : {}),
    },
  }
}

const DYNAMIC_SCHEMA = `
  query ReloadSchema {
    projectTypes: __type(name: "ProjectTypes") {
      enumValues { name description }
    }
    taskTypes: __type(name: "TaskTypes") {
      enumValues { name description }
    }
    taskInput: __type(name: "TaskInput") {
      inputFields { name }
    }
  }
`

export async function loadDynamicSchema(session: ConsolidateSession): Promise<{
  projectTypes: EnumValue[]
  taskTypes: EnumValue[]
  taskInputFields: Set<string>
}> {
  const result = await sessionGraphql<{
    projectTypes: { enumValues: EnumValue[] } | null
    taskTypes: { enumValues: EnumValue[] } | null
    taskInput: { inputFields: { name: string }[] } | null
  }>(session, DYNAMIC_SCHEMA, undefined, {
    "cache-control": "no-cache",
    pragma: "no-cache",
  })
  return {
    projectTypes: result.data?.projectTypes?.enumValues ?? [],
    taskTypes: result.data?.taskTypes?.enumValues ?? [],
    taskInputFields: new Set(result.data?.taskInput?.inputFields.map((field) => field.name) ?? []),
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
    logo?: Buffer
    securityRules?: SecurityRuleInput[]
  }
): Promise<{ id: string; displayName: string; hasLogo: boolean }> {
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
  const variants: Record<string, unknown>[] = company.logo
    ? [
        { ...withAddress, logo: { file: null } },
        { ...nameOnly, logo: { file: null } },
        withAddress,
        nameOnly,
      ]
    : [withAddress, nameOnly]

  let lastMessage = "Unternehmen wurde nicht angelegt."
  let securityRules = company.securityRules
  for (const dataEntry of variants) {
    const post = (rules: SecurityRuleInput[] | undefined) => {
      const input = { dataEntry, ...(rules ? { securityRules: rules } : {}) }
      return dataEntry.logo && company.logo
        ? sessionGraphqlUpload<{
            createCompany: { company: { id: string; displayName: string } | null }
          }>(session, CREATE_COMPANY, { input }, [
            {
              path: "variables.input.dataEntry.logo.file",
              filename: "logo.png",
              contentType: "image/png",
              body: company.logo,
            },
          ])
        : sessionGraphql<{
            createCompany: { company: { id: string; displayName: string } | null }
          }>(session, CREATE_COMPANY, { input })
    }
    try {
      let result = await post(securityRules)
      let created = result.data?.createCompany?.company
      lastMessage = created ? lastMessage : collectMessages(result.errors) || lastMessage
      if (!created && securityRules && /securityRules/i.test(lastMessage)) {
        securityRules = undefined
        result = await post(undefined)
        created = result.data?.createCompany?.company
        lastMessage = created ? lastMessage : collectMessages(result.errors) || lastMessage
      }
      if (created) return { ...created, hasLogo: Boolean(dataEntry.logo) }
    } catch (error) {
      lastMessage = errorText(error)
      if (securityRules && /securityRules/i.test(lastMessage)) securityRules = undefined
    }
  }
  throw new Error(lastMessage)
}

const CONTACT_SALUTATIONS = `
  query ContactSalutations($dataCollection: DataCollection!) {
    dataForm(dataCollection: $dataCollection) {
      fields {
        key
        ... on ValueFieldDefinition {
          comboBoxOptions { id value }
        }
      }
    }
  }
`

export async function loadSalutationOptions(
  session: ConsolidateSession,
  dataCollection: string | undefined
): Promise<{ id: number; value: string }[]> {
  if (!dataCollection) return []
  const result = await sessionGraphql<{
    dataForm: {
      fields: { key: string; comboBoxOptions?: { id: number; value: string }[] | null }[]
    } | null
  }>(session, CONTACT_SALUTATIONS, { dataCollection })
  if (result.errors?.length && !result.data?.dataForm) {
    throw new Error(collectMessages(result.errors))
  }
  const field = result.data?.dataForm?.fields.find((item) => item.key === "salutation")
  return field?.comboBoxOptions ?? []
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
    avatar?: { filename: string; contentType: string; body: Buffer }
    salutation?: number
    securityRules?: { key: { userId?: string; roleId?: string; groupId?: string }; value: string }[]
  }
): Promise<{ id: string; displayName: string; linkedCompany: boolean; hasAvatar: boolean }> {
  const dataEntry: Record<string, unknown> = {
    firstName: person.firstName,
    lastName: person.lastName,
    email: [person.email],
  }
  if (person.phone) dataEntry.phoneNumber = [person.phone]
  if (person.companyId) {
    dataEntry.company = [
      {
        companyId: person.companyId,
        ...(person.position ? { position: person.position } : {}),
        ...(person.department ? { department: person.department } : {}),
        includeInCrossReferences: true,
      },
    ]
  }
  if (typeof person.salutation === "number") dataEntry.salutation = person.salutation
  if (person.avatar) dataEntry.avatar = { file: null }

  let lastMessage = "Kontakt wurde nicht angelegt."
  let avatarAttempted = Boolean(person.avatar)
  let securityRules = person.securityRules
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let result: Awaited<ReturnType<typeof postContact>>
    try {
      result = await postContact(session, dataEntry, person.avatar, securityRules)
    } catch (error) {
      if (!dataEntry.avatar) throw error
      delete dataEntry.avatar
      avatarAttempted = false
      lastMessage = errorText(error)
      continue
    }
    const contact = result.data?.createContact?.contact
    if (contact) {
      return {
        ...contact,
        linkedCompany: Boolean(dataEntry.company),
        hasAvatar: Boolean(dataEntry.avatar),
      }
    }
    lastMessage = collectMessages(result.errors) || lastMessage
    const missing = missingInputField(lastMessage)
    if (missing && Object.prototype.hasOwnProperty.call(dataEntry, missing)) {
      delete dataEntry[missing]
      continue
    }
    if (securityRules && /securityRules/i.test(lastMessage)) {
      securityRules = undefined
      continue
    }
    if (dataEntry.phoneNumber && /phone/i.test(lastMessage)) {
      delete dataEntry.phoneNumber
      continue
    }
    if (typeof dataEntry.salutation === "number" && /salutation|anrede/i.test(lastMessage)) {
      delete dataEntry.salutation
      continue
    }
    if (dataEntry.avatar && avatarAttempted) {
      delete dataEntry.avatar
      avatarAttempted = false
      continue
    }
    break
  }
  throw new Error(lastMessage)
}

function postContact(
  session: ConsolidateSession,
  dataEntry: Record<string, unknown>,
  avatar: { filename: string; contentType: string; body: Buffer } | undefined,
  securityRules: { key: { userId?: string; roleId?: string; groupId?: string }; value: string }[] | undefined
) {
  const input: Record<string, unknown> = { dataEntry }
  if (securityRules) input.securityRules = securityRules
  const variables = { input }
  if (dataEntry.avatar && avatar) {
    return sessionGraphqlUpload<{
      createContact: { contact: { id: string; displayName: string } | null }
    }>(session, CREATE_CONTACT, variables, [
      {
        path: "variables.input.dataEntry.avatar.file",
        filename: avatar.filename,
        contentType: avatar.contentType,
        body: avatar.body,
      },
    ])
  }
  return sessionGraphql<{
    createContact: { contact: { id: string; displayName: string } | null }
  }>(session, CREATE_CONTACT, variables)
}

const SECURITY_TEMPLATE_FIELDS = `
  value
  key {
    __typename
    ... on User { id }
    ... on BasicRole { id }
    ... on Team { id }
    ... on SecurityGroup { id }
  }
`

const CREATE_USER = `
  mutation CreateUser($input: CreateUserInput!) {
    createUser(input: $input) {
      user {
        id
        email
        displayName
        firstName
        lastName
        securityTemplate { ${SECURITY_TEMPLATE_FIELDS} }
      }
      errors { ... on Error { message } }
    }
  }
`

const EDIT_SECURITY_TEMPLATE = `
  mutation EditSecurityTemplate($input: EditSecurityTemplateInput!) {
    editSecurityTemplate(input: $input) {
      iSecurityTemplateProvider {
        securityTemplate { ${SECURITY_TEMPLATE_FIELDS} }
      }
    }
  }
`

type SecurityKey = {
  __typename?: string | null
  id?: string | null
}

type SecurityRule = {
  value: string
  key: SecurityKey | null
}

function principalInput(key: SecurityKey | null): { userId?: string; roleId?: string; groupId?: string } {
  if (!key?.id || !key.__typename) {
    throw new Error("Eine bestehende Sicherheitsregel des Benutzers konnte nicht gelesen werden.")
  }
  if (key.__typename === "User") return { userId: key.id }
  if (key.__typename === "SecurityGroup") return { groupId: key.id }
  if (key.__typename === "BasicRole" || key.__typename === "Team") return { roleId: key.id }
  throw new Error(`Unbekannter Sicherheitsprinzipal ${key.__typename}.`)
}

function withAdminManage(rules: SecurityRule[] | null, adminUserId: string) {
  const template = (rules ?? []).map((rule) => ({
    key: principalInput(rule.key),
    value: rule.value,
  }))
  const existing = template.find((rule) => rule.key.userId === adminUserId)
  if (existing) existing.value = "Manage"
  else template.push({ key: { userId: adminUserId }, value: "Manage" })
  return template
}

function adminHasManage(rules: SecurityRule[] | null | undefined, adminUserId: string): boolean {
  return (rules ?? []).some(
    (rule) => rule.key?.__typename === "User" && rule.key.id === adminUserId && rule.value === "Manage"
  )
}

export type SecurityRuleInput = {
  key: { userId?: string; roleId?: string; groupId?: string }
  value: string
}

const ACCESS_RANK: Record<string, number> = { None: 0, Read: 1, Edit: 2, Manage: 3 }

export function withReaderRoles(rules: SecurityRuleInput[], roleIds: string[]): SecurityRuleInput[] {
  const next = rules.map((rule) => ({ key: { ...rule.key }, value: rule.value }))
  for (const roleId of roleIds) {
    if (!roleId) continue
    const existing = next.find((rule) => rule.key.roleId === roleId)
    if (!existing) {
      next.push({ key: { roleId }, value: "Read" })
      continue
    }
    if ((ACCESS_RANK[existing.value] ?? 0) < ACCESS_RANK.Read) existing.value = "Read"
  }
  return next
}

const FORM_SECURITY = `
  query FormSecurity($dataCollection: DataCollection!) {
    dataForm(dataCollection: $dataCollection) {
      securityTemplate { ${SECURITY_TEMPLATE_FIELDS} }
    }
  }
`

export async function securityRulesForNewEntry(
  session: ConsolidateSession,
  dataCollection: string,
  adminUserId: string
): Promise<{ key: { userId?: string; roleId?: string; groupId?: string }; value: string }[]> {
  const result = await sessionGraphql<{
    dataForm: { securityTemplate: SecurityRule[] | null } | null
  }>(session, FORM_SECURITY, { dataCollection })
  const message = collectMessages(result.errors)
  if (message || !result.data?.dataForm) {
    throw new Error(message || "Die Formularrechte konnten nicht gelesen werden.")
  }
  return withAdminManage(result.data.dataForm.securityTemplate, adminUserId)
}

const UPDATE_ENTRY_SECURITY = `
  mutation UpdateEntrySecurity($input: UpdateDataEntrySecurityInput!) {
    updateDataEntrySecurity(input: $input) {
      dataEntry { id }
      errors { ... on Error { message } }
    }
  }
`

export async function grantDataEntrySecurity(
  session: ConsolidateSession,
  id: string,
  securityRules: SecurityRuleInput[]
): Promise<void> {
  const result = await sessionGraphql<{
    updateDataEntrySecurity: {
      dataEntry: { id: string } | null
      errors: PayloadError[] | null
    } | null
  }>(session, UPDATE_ENTRY_SECURITY, { input: { id, securityRules } })
  const payload = result.data?.updateDataEntrySecurity
  const message = collectMessages(result.errors, payload?.errors)
  if (!payload?.dataEntry) throw new Error(message || "Die Leserechte wurden nicht gesetzt.")
}

const CALENDAR_READ_RANK: Record<string, number> = {
  NotShared: 0,
  CanViewWhenBusy: 1,
  CanViewTitlesAndLocations: 2,
  CanViewAllDetails: 3,
  CanEdit: 4,
}

const CALENDAR_SHARES = `
  query CalendarShares($id: ID!) {
    calendar(id: $id) {
      permissions {
        global
        userPermissions {
          calendarPermission
          user { id }
        }
      }
    }
  }
`

const SHARE_CALENDAR = `
  mutation ShareCalendar($input: SetCalendarUserPermissionInput!) {
    setCalendarUserPermission(input: $input) {
      calendar { id }
    }
  }
`

export async function shareCalendarWithUsers(
  session: ConsolidateSession,
  calendarId: string,
  userIds: string[]
): Promise<{ shared: number; failed: number; message?: string }> {
  const loaded = await sessionGraphql<{
    calendar: {
      permissions: {
        global: string
        userPermissions: { calendarPermission: string; user: { id: string } }[]
      }
    } | null
  }>(session, CALENDAR_SHARES, { id: calendarId })
  const permissions = loaded.data?.calendar?.permissions
  const current = new Map(
    (permissions?.userPermissions ?? []).map((entry) => [entry.user.id, entry.calendarPermission])
  )
  if ((CALENDAR_READ_RANK[permissions?.global ?? ""] ?? 0) >= CALENDAR_READ_RANK.CanViewAllDetails) {
    return { shared: userIds.length, failed: 0 }
  }

  let shared = 0
  let failed = 0
  let message = ""
  for (const userId of userIds) {
    const existing = current.get(userId)
    if (existing && (CALENDAR_READ_RANK[existing] ?? 0) >= CALENDAR_READ_RANK.CanViewAllDetails) {
      shared += 1
      continue
    }
    const result = await sessionGraphql<{
      setCalendarUserPermission: { calendar: { id: string } | null } | null
    }>(session, SHARE_CALENDAR, {
      input: { id: calendarId, user: userId, permission: "CanViewAllDetails" },
    })
    if (result.data?.setCalendarUserPermission?.calendar) {
      shared += 1
      continue
    }
    failed += 1
    message = collectMessages(result.errors) || message
  }
  return { shared, failed, message: message || undefined }
}

async function writeSecurityTemplate(
  session: ConsolidateSession,
  userId: string,
  template: SecurityRuleInput[]
): Promise<{ saved: SecurityRule[] | null; message: string }> {
  const result = await sessionGraphql<{
    editSecurityTemplate: {
      iSecurityTemplateProvider: { securityTemplate: SecurityRule[] | null } | null
    } | null
  }>(session, EDIT_SECURITY_TEMPLATE, { input: { id: userId, template } })
  return {
    saved: result.data?.editSecurityTemplate?.iSecurityTemplateProvider?.securityTemplate ?? null,
    message: collectMessages(result.errors),
  }
}

async function grantAdminManage(
  session: ConsolidateSession,
  userId: string,
  adminUserId: string,
  current: SecurityRule[] | null,
  readerRoleIds: string[]
): Promise<void> {
  const manageOnly = withAdminManage(current, adminUserId)
  let written = await writeSecurityTemplate(
    session,
    userId,
    withReaderRoles(manageOnly, readerRoleIds)
  )
  if (!adminHasManage(written.saved, adminUserId) && readerRoleIds.length > 0) {
    written = await writeSecurityTemplate(session, userId, manageOnly)
  }
  if (!adminHasManage(written.saved, adminUserId)) {
    throw new Error(written.message || "Das Manage-Recht für den verbundenen Service-User wurde nicht gesetzt.")
  }
}

export async function createEmployee(
  session: ConsolidateSession,
  input: {
    email: string
    password: string
    contactId?: string
    roleIds: string[]
    adminUserId: string
    readerRoleIds?: string[]
  }
): Promise<{ id: string; email: string; displayName: string }> {
  const result = await sessionGraphql<{
    createUser: {
      user: {
        id: string
        email: string
        displayName: string
        securityTemplate: SecurityRule[] | null
      } | null
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
  await grantAdminManage(
    session,
    user.id,
    input.adminUserId,
    user.securityTemplate,
    input.readerRoleIds ?? []
  )
  return user
}

const CREATE_PROJECT = `
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      project { id displayName }
    }
  }
`

function missingInputField(message: string): string | null {
  return message.match(/The field `([^`]+)` does not exist on the type/i)?.[1] ?? null
}

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
    securityRules?: SecurityRuleInput[]
  }
): Promise<{ id: string; displayName: string; linkedType: boolean }> {
  let dataEntry: Record<string, unknown> = {
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    description: { htmlText: `<p>${escapeHtml(input.summary)}</p>` },
    ...(input.projectManagerId ? { projectManager: input.projectManagerId } : {}),
    ...(input.responsibleId ? { responsible: input.responsibleId } : {}),
  }
  let typeName = input.typeName
  let securityRules = input.securityRules
  let lastMessage = "Projekt wurde nicht angelegt."

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await sessionGraphql<{
      createProject: { project: { id: string; displayName: string } | null }
    }>(session, CREATE_PROJECT, {
      input: {
        dataEntry,
        ...(typeName ? { type: typeName } : {}),
        ...(securityRules ? { securityRules } : {}),
      },
    })
    const created = result.data?.createProject?.project
    if (created) return { ...created, linkedType: Boolean(typeName) }

    lastMessage = collectMessages(result.errors) || lastMessage
    if (securityRules && /securityRules/i.test(lastMessage)) {
      securityRules = undefined
      continue
    }
    const missing = missingInputField(lastMessage)
    if (missing && Object.prototype.hasOwnProperty.call(dataEntry, missing)) {
      const next = { ...dataEntry }
      delete next[missing]
      dataEntry = next
      continue
    }
    if (typeName && /type|enum|ProjectTypes|ValueNotAllowed/i.test(lastMessage)) {
      typeName = undefined
      continue
    }
    break
  }

  throw new Error(lastMessage)
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
    fallbackStatusId?: string
    typeName?: string
    extraFields?: Record<string, string | number | boolean>
    securityRules?: SecurityRuleInput[]
  }
): Promise<{ id: string; displayName: string; changeVector?: string | null; linkedType: boolean; fieldsApplied: boolean }> {
  const baseEntry: Record<string, unknown> = {
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
  const withoutResponsible = { ...baseEntry }
  delete withoutResponsible.responsible

  const variants: { dataEntry: Record<string, unknown>; typeName?: string; fieldsApplied: boolean }[] = [
    { dataEntry: { ...baseEntry, ...extra }, typeName: input.typeName, fieldsApplied: hasExtra },
  ]
  if (hasExtra) variants.push({ dataEntry: { ...baseEntry }, typeName: input.typeName, fieldsApplied: false })
  if (input.typeName) variants.push({ dataEntry: { ...baseEntry }, fieldsApplied: false })
  if (input.responsibleId) variants.push({ dataEntry: { ...withoutResponsible }, fieldsApplied: false })
  if (input.fallbackStatusId && input.fallbackStatusId !== input.statusId) {
    variants.push({
      dataEntry: { ...withoutResponsible, status: input.fallbackStatusId },
      fieldsApplied: false,
    })
  }
  variants.push({
    dataEntry: {
      subject: input.subject,
      status: input.fallbackStatusId || input.statusId,
      priority: input.priority,
      startDate: input.startDate,
      dueDate: input.dueDate,
      description: baseEntry.description,
    },
    fieldsApplied: false,
  })

  let securityRules = input.securityRules
  const post = (dataEntry: Record<string, unknown>, typeName?: string) =>
    sessionGraphql<{
      createTask: { task: { id: string; displayName: string; changeVector?: string | null } | null }
    }>(session, CREATE_TASK, {
      input: {
        dataEntry,
        ...(typeName ? { type: typeName } : {}),
        ...(securityRules ? { securityRules } : {}),
      },
    })

  let lastMessage = "Aufgabe wurde nicht angelegt."
  for (const variant of variants) {
    const result = await post(variant.dataEntry, variant.typeName)
    const task = result.data?.createTask?.task
    if (task) {
      return {
        ...task,
        linkedType: Boolean(variant.typeName),
        fieldsApplied: variant.fieldsApplied,
      }
    }
    lastMessage = collectMessages(result.errors) || lastMessage
    if (securityRules && /securityRules|ValueNotAllowed/i.test(lastMessage)) {
      securityRules = undefined
      const retry = await post(variant.dataEntry, variant.typeName)
      const retried = retry.data?.createTask?.task
      if (retried) {
        return {
          ...retried,
          linkedType: Boolean(variant.typeName),
          fieldsApplied: variant.fieldsApplied,
        }
      }
      lastMessage = collectMessages(retry.errors) || lastMessage
    }
    if (!/ValueNotAllowed|UnknownField|service user|type|enum|TaskTypes|not allowed/i.test(lastMessage)) break
  }
  throw new Error(lastMessage)
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

const CURRENT_CHANGE_VECTOR = `
  query CurrentChangeVector($id: ID!) {
    dataEntry(id: $id) { changeVector }
  }
`

async function readChangeVector(session: ConsolidateSession, id: string): Promise<string | undefined> {
  const result = await sessionGraphql<{ dataEntry: { changeVector?: string | null } | null }>(
    session,
    CURRENT_CHANGE_VECTOR,
    { id }
  )
  return result.data?.dataEntry?.changeVector ?? undefined
}

function vectorFromConflict(message: string): string | undefined {
  return message.match(/but found\s+['"]([^'"]+)['"]/i)?.[1]
}

function isChangeConflict(message: string): boolean {
  return /change vector|document was changed/i.test(message)
}

async function runWithChangeVector<T extends { changeVector?: string | null }>(
  session: ConsolidateSession,
  id: string,
  startingVector: string | undefined,
  run: (changeVector: string | undefined) => Promise<{ ok: boolean; message: string; value?: T }>
): Promise<{ value: T; vector: string | undefined }> {
  let vector = startingVector || (await readChangeVector(session, id))
  let outcome = await run(vector)
  for (let attempt = 0; attempt < 4 && !outcome.ok && isChangeConflict(outcome.message); attempt += 1) {
    const found = vectorFromConflict(outcome.message)
    const fresh = found === vector ? await readChangeVector(session, id) : undefined
    const next = found && found !== vector ? found : fresh && fresh !== vector ? fresh : undefined
    if (!next) break
    vector = next
    outcome = await run(vector)
  }
  if (!outcome.ok || !outcome.value) {
    throw new Error(outcome.message || "Der Änderungsstand konnte nicht übernommen werden.")
  }
  return { value: outcome.value, vector: outcome.value.changeVector ?? vector }
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
  const uploadBody = input.versions[0]
  const uploadOnce = (changeVector: string | undefined) =>
    sessionGraphqlUpload<{
      updateTask: { task: TaskFileState | null }
    }>(
      session,
      UPDATE_TASK_FILE,
      {
        input: {
          id: input.taskId,
          ...(changeVector ? { changeVector } : {}),
          newAttachments: [{ file: null }],
        },
      },
      [
        {
          path: "variables.input.newAttachments.0.file",
          filename: input.fileName,
          contentType: input.contentType,
          body: uploadBody,
        },
      ]
    )

  const uploaded = await runWithChangeVector(
    session,
    input.taskId,
    input.changeVector ?? undefined,
    async (changeVector) => {
      const result = await uploadOnce(changeVector)
      const message = collectMessages(result.errors)
      const task = isChangeConflict(message) ? undefined : result.data?.updateTask?.task ?? undefined
      return {
        ok: Boolean(task),
        message: message || (task ? "" : "Die Datei wurde nicht angehängt."),
        value: task,
      }
    }
  )
  const task = uploaded.value
  let changeVector = uploaded.vector
  const attachment = task.attachments?.find((item) => item.name === input.fileName) ?? task.attachments?.at(-1)
  if (!attachment) throw new Error("Die Datei wurde nicht angehängt.")
  if (input.versions.length === 1) return { versionCount: attachment.versionCount || 1 }

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
    const drafted = await runWithChangeVector(session, input.taskId, changeVector, async (vector) => {
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
            ...(vector ? { changeVector: vector } : {}),
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
      const message = collectMessages(draft.errors, draft.data?.createDraft?.errors)
      const entry = isChangeConflict(message) ? undefined : draft.data?.createDraft?.dataEntry ?? undefined
      return {
        ok: Boolean(entry),
        message: message || (entry ? "" : `Version ${index + 1} wurde nicht angelegt.`),
        value: entry,
      }
    })
    changeVector = drafted.vector
    const approved = await runWithChangeVector(session, input.taskId, changeVector, async (vector) => {
      const result = await sessionGraphql<{
        approveDraft: { dataEntry: TaskFileState | null; errors: PayloadError[] | null }
      }>(session, APPROVE_DRAFT, {
        input: {
          dataEntryId: input.taskId,
          attachmentId: attachment.id,
          comment: `Version ${index + 1}`,
          ...(vector ? { changeVector: vector } : {}),
        },
      })
      const message = collectMessages(result.errors, result.data?.approveDraft?.errors)
      const entry = isChangeConflict(message) ? undefined : result.data?.approveDraft?.dataEntry ?? undefined
      return {
        ok: Boolean(entry),
        message: message || (entry ? "" : `Version ${index + 1} wurde nicht freigegeben.`),
        value: entry,
      }
    })
    changeVector = approved.vector
    const count = approved.value.attachments?.find((item) => item.id === attachment.id)?.versionCount
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
      entity {
        ... on Task { changeVector }
        ... on DataEntry { changeVector }
      }
      errors { ... on Error { message } }
    }
  }
`

export async function associateRecords(
  session: ConsolidateSession,
  entityId: string,
  associationId: string,
  changeVector?: string | null
): Promise<string | undefined> {
  let vector = changeVector ?? undefined
  let message = "Die Verknüpfung wurde nicht gespeichert."
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await sessionGraphql<{
      addAssociation: {
        entity: { changeVector?: string | null } | null
        errors: PayloadError[] | null
      } | null
    }>(session, ADD_ASSOCIATION, {
      input: {
        entity: entityId,
        association: associationId,
        ...(vector ? { changeVector: vector } : {}),
      },
    })
    message = collectMessages(result.errors, result.data?.addAssociation?.errors)
    if (!message && result.data?.addAssociation) {
      return result.data.addAssociation.entity?.changeVector ?? vector
    }
    const found = vectorFromConflict(message)
    if (!found || found === vector || !isChangeConflict(message)) break
    vector = found
  }
  throw new Error(message)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}
