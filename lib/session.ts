import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"
import { cookies } from "next/headers"

export const SESSION_COOKIE = "consi_demo_sid"

export type PublicSession = {
  connected: true
  instanceUrl: string
  appUrl: string
  username: string
  displayName: string
  email: string
  isAdmin: boolean
}

export type ConsolidateSession = PublicSession & {
  id: string
  apiKey: string
  cookieHeader: string
}

type SessionStore = Map<string, ConsolidateSession>

const globalStore = globalThis as typeof globalThis & {
  __consiDemoSessions?: SessionStore
}

function store(): SessionStore {
  globalStore.__consiDemoSessions ??= new Map()
  return globalStore.__consiDemoSessions
}

function secretKey(): Buffer {
  const configured = process.env.SESSION_SECRET?.trim()
  const secret =
    configured || (process.env.NODE_ENV === "production" ? "" : "consi-demo-local-session")
  if (!secret) {
    throw new Error("SESSION_SECRET fehlt in der Umgebung. Die Sitzung kann online nicht gehalten werden.")
  }
  return createHash("sha256").update(secret).digest()
}

function seal(session: ConsolidateSession, cookieHeader: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv)
  const plaintext = Buffer.from(
    JSON.stringify({
      id: session.id,
      instanceUrl: session.instanceUrl,
      appUrl: session.appUrl,
      username: session.username,
      displayName: session.displayName,
      email: session.email,
      isAdmin: session.isAdmin,
      apiKey: session.apiKey,
      cookieHeader,
    })
  )
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString("base64url")
}

function open(token: string): ConsolidateSession | null {
  try {
    const payload = Buffer.from(token, "base64url")
    if (payload.length < 29) return null
    const iv = payload.subarray(0, 12)
    const tag = payload.subarray(12, 28)
    const encrypted = payload.subarray(28)
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv)
    decipher.setAuthTag(tag)
    const json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")
    const parsed = JSON.parse(json) as Partial<ConsolidateSession>
    if (!parsed.apiKey || !parsed.id || !parsed.instanceUrl) return null
    return {
      id: parsed.id,
      connected: true,
      instanceUrl: parsed.instanceUrl,
      appUrl: parsed.appUrl ?? "",
      username: parsed.username ?? "",
      displayName: parsed.displayName ?? "",
      email: parsed.email ?? "",
      isAdmin: Boolean(parsed.isAdmin),
      apiKey: parsed.apiKey,
      cookieHeader: parsed.cookieHeader ?? "",
    }
  } catch {
    return null
  }
}

export function saveSession(session: ConsolidateSession): void {
  store().set(session.id, session)
}

export function deleteSession(id: string): void {
  store().delete(id)
}

export async function readSession(): Promise<ConsolidateSession | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  let session: ConsolidateSession | null
  try {
    session = open(token)
  } catch {
    return null
  }
  if (!session) return null
  const cached = store().get(session.id)
  return cached?.apiKey ? cached : session
}

export function toPublicSession(session: ConsolidateSession): PublicSession {
  return {
    connected: true,
    instanceUrl: session.instanceUrl,
    appUrl: session.appUrl,
    username: session.username,
    displayName: session.displayName,
    email: session.email,
    isAdmin: session.isAdmin,
  }
}

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 8,
}

export async function writeSessionCookie(session: ConsolidateSession): Promise<void> {
  saveSession(session)
  let token = seal(session, session.cookieHeader)
  if (token.length > 3500) token = seal(session, "")
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, token, cookieOptions)
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (token) {
    try {
      const session = open(token)
      if (session) deleteSession(session.id)
    } catch {
      // An unreadable cookie is removed below.
    }
  }
  cookieStore.delete(SESSION_COOKIE)
}
