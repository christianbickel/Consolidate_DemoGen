import type { DemoPlan } from "@/lib/demo-plan"

export type LogLevel = "info" | "success" | "error"

export type ImportSummary = {
  projectTypes: number
  taskTypes: number
  teams: number
  employees: number
  companies: number
  contacts: number
  projects: number
  tasks: number
  appointments: number
  failed: number
  appUrl: string
  demoPassword: string
}

export type StreamEvent =
  | { type: "log"; level: LogLevel; message: string }
  | { type: "progress"; completed: number; total: number; label: string }
  | { type: "plan"; plan: DemoPlan }
  | { type: "summary"; summary: ImportSummary }
  | { type: "error"; message: string }

export function encodeEvent(event: StreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`)
}

export async function readNdjson(
  response: Response,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  if (!response.ok || !response.body) {
    let message = `Anfrage fehlgeschlagen (HTTP ${response.status}).`
    try {
      const payload = (await response.json()) as { error?: string }
      if (payload.error) message = payload.error
    } catch {
      // The body was already consumed or was not JSON.
    }
    throw new Error(message)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      onEvent(JSON.parse(line) as StreamEvent)
    }
  }

  if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent)
}
