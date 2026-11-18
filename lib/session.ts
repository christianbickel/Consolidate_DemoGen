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

export function saveSession(session: ConsolidateSession): void {
  store().set(session.id, session)
}

export function deleteSession(id: string): void {
  store().delete(id)
}

export async function readSession(): Promise<ConsolidateSession | null> {
  const cookieStore = await cookies()
  const id = cookieStore.get(SESSION_COOKIE)?.value
  if (!id) return null
  const session = store().get(id)
  if (!session?.apiKey) return null
  return session
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

export async function writeSessionCookie(id: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  const id = cookieStore.get(SESSION_COOKIE)?.value
  if (id) deleteSession(id)
  cookieStore.delete(SESSION_COOKIE)
}
