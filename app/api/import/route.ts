import { importDemoPlan } from "@/lib/import-demo"
import { demoPlanSchema } from "@/lib/demo-plan"
import { errorText } from "@/lib/consolidate"
import { readSession } from "@/lib/session"
import { encodeEvent, type StreamEvent } from "@/lib/stream-events"

export const maxDuration = 300

export async function POST(request: Request) {
  const session = await readSession()
  if (!session) {
    return Response.json({ error: "Nicht mit einer Instanz verbunden." }, { status: 401 })
  }

  const json = await request.json().catch(() => null)
  const parsed = demoPlanSchema.safeParse(json)
  if (!parsed.success) {
    return Response.json({ error: "Die Vorschau ist unvollständig und kann nicht importiert werden." }, { status: 400 })
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => controller.enqueue(encodeEvent(event))
      try {
        const summary = await importDemoPlan(session, parsed.data, emit)
        emit({ type: "summary", summary })
      } catch (error) {
        emit({ type: "error", message: errorText(error) })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  })
}
