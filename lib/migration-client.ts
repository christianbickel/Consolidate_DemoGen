import type { ConsolidateSession } from "@/lib/session"
import { collectMessages, sessionGraphql } from "@/lib/consolidate"

import type { MigrationBlob } from "@/lib/migration-package"

export type BatchStatus = {
  sequence: number
  batchId?: string | null
  installationId: string
  phase: "importing" | "finished"
  outcome?: "succeeded" | "completedWithErrors" | "failed" | null
  mode?: "apply" | "validate" | null
  lastAppliedSequence: number
  counts?: {
    total: number
    applied: number
    unchanged: number
    mapped: number
    failed: number
  } | null
  pendingBlobs?: number | null
  failureReason?: string | null
}

export type MigrationErrorEntry = {
  file: string
  line: number
  sourceId?: string | null
  code: string
  message: string
}

export class MigrationSequenceError extends Error {
  constructor() {
    super("Die Batch-Nummer passt nicht zur Instanz. Der Import setzt neu auf.")
  }
}

export async function loadGrantedPermissions(session: ConsolidateSession): Promise<string[]> {
  const result = await sessionGraphql<{
    roles: { isDefault: boolean; permissions: { key: string; value: boolean }[] }[]
  }>(
    session,
    `query RolePermissions { roles { isDefault permissions { key value } } }`
  )
  const role = result.data?.roles.find((entry) => entry.isDefault) ?? result.data?.roles[0]
  return (role?.permissions ?? []).filter((entry) => entry.value).map((entry) => entry.key)
}

export async function loadEmployeeRoles(
  session: ConsolidateSession
): Promise<{ id: string; email: string; displayName: string; isActive: boolean; isSystem: boolean; roleIds: string[] }[]> {
  const result = await sessionGraphql<{
    allUsers: {
      id: string
      email: string
      displayName: string
      isActive: boolean
      isSystem: boolean
      roles: { id: string }[]
    }[]
  }>(
    session,
    `query EmployeeRoles($userType: UserType!) {
      allUsers(userType: $userType) { id email displayName isActive isSystem roles { id } }
    }`,
    { userType: "Employee" }
  )
  if (result.errors?.length && !result.data?.allUsers) {
    throw new Error(collectMessages(result.errors) || "Die Mitarbeiter konnten nicht gelesen werden.")
  }
  return (result.data?.allUsers ?? []).map((user) => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isActive: user.isActive,
    isSystem: user.isSystem,
    roleIds: user.roles.map((role) => role.id),
  }))
}

export async function loadRoleDocuments(
  session: ConsolidateSession
): Promise<{ id: string; name: string; databaseId: string }[]> {
  const result = await sessionGraphql<{
    roles: { id: string; name: string; databaseId: string }[]
  }>(session, `query RoleDocuments { roles { id name databaseId } }`)
  return result.data?.roles ?? []
}

export async function latestBatch(
  session: ConsolidateSession,
  installationId: string
): Promise<BatchStatus | null> {
  const response = await migrationFetch(session, `/api/migration/batches/${installationId}/latest`)
  if (response.status === 404) return null
  return readStatus(response)
}

export async function submitPackage(
  session: ConsolidateSession,
  installationId: string,
  body: Buffer
): Promise<BatchStatus> {
  const response = await migrationFetch(
    session,
    `/api/migration/batches?mode=apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: new Uint8Array(body),
    }
  )
  if (response.status === 409) throw new MigrationSequenceError()
  if (response.status !== 202) {
    throw new Error(await response.text() || `Das Migrationspaket wurde abgelehnt (HTTP ${response.status}).`)
  }
  return readStatus(response)
}

export async function waitForBatch(
  session: ConsolidateSession,
  installationId: string,
  sequence: number
): Promise<BatchStatus> {
  const started = Date.now()
  while (Date.now() - started < 240_000) {
    const response = await migrationFetch(
      session,
      `/api/migration/batches/${installationId}/${sequence}`
    )
    if (response.status === 404) {
      await delay(1000)
      continue
    }
    const latest = await readStatus(response)
    if (latest.phase === "finished") return latest
    await delay(2000)
  }
  throw new Error("Der Import auf der Instanz ist nach vier Minuten noch nicht fertig.")
}

export async function readMigrationErrors(
  session: ConsolidateSession,
  installationId: string,
  sequence: number
): Promise<MigrationErrorEntry[]> {
  const response = await migrationFetch(
    session,
    `/api/migration/batches/${installationId}/${sequence}/errors`
  )
  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(await response.text() || `Der Fehlerbericht fehlt (HTTP ${response.status}).`)
  }
  const text = await response.text()
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MigrationErrorEntry)
}

export async function uploadMigrationBlob(
  session: ConsolidateSession,
  installationId: string,
  blob: MigrationBlob
): Promise<number> {
  const response = await migrationFetch(
    session,
    `/api/migration/blobs/${installationId}?blobId=${encodeURIComponent(blob.id)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": blob.contentType,
        "Content-Length": String(blob.body.length),
      },
      body: new Uint8Array(blob.body),
    }
  )
  return response.status
}

async function migrationFetch(
  session: ConsolidateSession,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = new URL(session.instanceUrl)
  const target = new URL(path, url.origin)
  return fetch(target, {
    ...init,
    headers: {
      "X-API-Key": session.apiKey,
      ...(init?.headers ?? {}),
    },
  })
}

async function readStatus(response: Response): Promise<BatchStatus> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(text || `Die Migrationsschnittstelle antwortet mit HTTP ${response.status}.`)
  }
  return JSON.parse(text) as BatchStatus
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
