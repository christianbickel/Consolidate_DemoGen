import { errorText } from "@/lib/consolidate"
import { readSession } from "@/lib/session"
import { encodeEvent, type StreamEvent } from "@/lib/stream-events"
import { DEMO_WIPE_ERROR, instanceAllowsWipe } from "@/lib/wipe-guard"
import { wipeDemoInstance } from "@/lib/wipe-instance"

export const maxDuration = 300

export async function POST() {
  const session = await readSession()
  if (!session) {
    return Response.json({ error: "Nicht mit einer Instanz verbunden." }, { status: 401 })
  }
  if (!instanceAllowsWipe(session.instanceUrl)) {
    return Response.json({ error: DEMO_WIPE_ERROR }, { status: 400 })
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => controller.enqueue(encodeEvent(event))
      try {
        await wipeDemoInstance(session, emit)
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
