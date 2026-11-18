import { readSession, toPublicSession } from "@/lib/session"

export async function GET() {
  const session = await readSession()
  if (!session) return Response.json({ connected: false })
  return Response.json(toPublicSession(session))
}
