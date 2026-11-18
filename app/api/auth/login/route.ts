import { z } from "zod"

import { authenticate, buildSession, errorText } from "@/lib/consolidate"
import { normalizeGraphqlUrl } from "@/lib/demo-plan"
import { toPublicSession, writeSessionCookie } from "@/lib/session"

const loginSchema = z.object({
  instanceUrl: z.string().min(1),
  apiKey: z.string().min(1),
})

export async function POST(request: Request) {
  const json = await request.json().catch(() => null)
  const parsed = loginSchema.safeParse(json)
  if (!parsed.success) {
    return Response.json(
      { error: "Instanz-URL und API-Schlüssel werden benötigt." },
      { status: 400 }
    )
  }

  try {
    const instanceUrl = normalizeGraphqlUrl(parsed.data.instanceUrl)
    const apiKey = parsed.data.apiKey.trim()
    const auth = await authenticate(instanceUrl, apiKey)
    const session = buildSession({
      instanceUrl,
      apiKey,
      cookieHeader: auth.cookieHeader,
      me: auth.me,
    })
    await writeSessionCookie(session)
    return Response.json(toPublicSession(session))
  } catch (error) {
    return Response.json({ error: errorText(error) }, { status: 400 })
  }
}
