import { z } from "zod"

import { authenticate, buildSession, errorText } from "@/lib/consolidate"
import { normalizeGraphqlUrl } from "@/lib/demo-plan"
import {
  saveSession,
  toPublicSession,
  writeSessionCookie,
} from "@/lib/session"

const loginSchema = z.object({
  instanceUrl: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
})

export async function POST(request: Request) {
  const json = await request.json().catch(() => null)
  const parsed = loginSchema.safeParse(json)
  if (!parsed.success) {
    return Response.json(
      { error: "Instanz-URL, Benutzername und Passwort werden benötigt." },
      { status: 400 }
    )
  }

  try {
    const instanceUrl = normalizeGraphqlUrl(parsed.data.instanceUrl)
    const auth = await authenticate(
      instanceUrl,
      parsed.data.username.trim(),
      parsed.data.password
    )
    const session = buildSession({
      instanceUrl,
      username: parsed.data.username.trim(),
      cookieHeader: auth.cookieHeader,
      me: auth.me,
    })
    saveSession(session)
    await writeSessionCookie(session.id)
    return Response.json(toPublicSession(session))
  } catch (error) {
    return Response.json({ error: errorText(error) }, { status: 400 })
  }
}
