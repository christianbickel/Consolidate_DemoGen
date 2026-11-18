"use client"

import { useEffect, useRef } from "react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { LogLevel } from "@/lib/stream-events"

export type LogLine = {
  id: number
  level: LogLevel
  message: string
}

export function ActivityLog({ lines }: { lines: LogLine[] }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" })
  }, [lines])

  return (
    <ScrollArea className="h-80 rounded-lg border bg-muted/40">
      <div className="flex flex-col gap-1 p-3 font-mono text-xs">
        {lines.length === 0 ? (
          <p className="text-muted-foreground">Das Protokoll erscheint hier.</p>
        ) : (
          lines.map((line) => (
            <p
              key={line.id}
              className={cn(
                line.level === "error" && "text-destructive",
                line.level === "success" && "text-foreground",
                line.level === "info" && "text-muted-foreground"
              )}
            >
              {line.level === "success" ? "OK  " : line.level === "error" ? "ERR " : "…   "}
              {line.message}
            </p>
          ))
        )}
        <div ref={endRef} />
      </div>
    </ScrollArea>
  )
}
