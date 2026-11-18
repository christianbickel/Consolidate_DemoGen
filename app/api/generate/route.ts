import { z } from "zod"

import { languageSchema, presetIdSchema } from "@/lib/demo-plan"
import { generateDemoPlan } from "@/lib/generate-plan"
import { encodeEvent, type StreamEvent } from "@/lib/stream-events"
import { errorText } from "@/lib/consolidate"

export const maxDuration = 300

const requestSchema = z.object({
  language: languageSchema,
  profile: z.string().trim().min(20),
  presetId: presetIdSchema,
  apiKey: z.string().optional(),
})

export async function POST(request: Request) {
  const json = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(json)
  if (!parsed.success) {
    return Response.json(
      { error: "Sprache, Kundenprofil (mindestens 20 Zeichen) und Demo-Größe prüfen." },
      { status: 400 }
    )
  }
  if (!parsed.data.apiKey?.trim() && !process.env.OPENAI_API_KEY?.trim()) {
    return Response.json(
      {
        error:
          "Kein OpenAI-API-Key. Trage ihn im Formular ein oder setze OPENAI_API_KEY.",
      },
      { status: 400 }
    )
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: StreamEvent) => controller.enqueue(encodeEvent(event))
      try {
        const plan = await generateDemoPlan(parsed.data, emit)
        emit({ type: "plan", plan })
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
