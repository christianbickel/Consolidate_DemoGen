"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { LogInIcon, LogOutIcon, SparklesIcon } from "lucide-react"

import { ActivityLog, type LogLine } from "@/components/activity-log"
import { PlanPreview } from "@/components/plan-preview"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DEMO_PRESETS, type DemoPresetId } from "@/lib/demo-presets"
import type { DemoLanguage, DemoPlan } from "@/lib/demo-plan"
import {
  getProfileTemplates,
  getServerProfileTemplates,
  profileTemplateLabel,
  saveProfileTemplate,
  subscribeProfileTemplates,
} from "@/lib/profile-templates"
import { readNdjson, type ImportSummary, type StreamEvent } from "@/lib/stream-events"

type Step = "login" | "profile" | "generate"

type ConnectedSession = {
  connected: true
  instanceUrl: string
  appUrl: string
  username: string
  displayName: string
  email: string
  isAdmin: boolean
}

const STEPS: { id: Step; label: string }[] = [
  { id: "login", label: "Anmeldung" },
  { id: "profile", label: "Kundenprofil" },
  { id: "generate", label: "Generierung" },
]

const PROFILE_PLACEHOLDER =
  "Mittelständisches Maschinenbau-Unternehmen mit 80 Mitarbeitern, Fokus auf Sondermaschinenbau, Konstruktion, Montage vor Ort und After-Sales-Service"

export function DemoWizard() {
  const [step, setStep] = useState<Step>("login")
  const [session, setSession] = useState<ConnectedSession | null>(null)
  const [instanceUrl, setInstanceUrl] = useState("https://staging.consi.cloud/graphql")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [language, setLanguage] = useState<DemoLanguage>("de")
  const [profile, setProfile] = useState("")
  const templates = useSyncExternalStore(
    subscribeProfileTemplates,
    getProfileTemplates,
    getServerProfileTemplates
  )
  const submittedProfile = useRef("")
  const [presetId, setPresetId] = useState<DemoPresetId>("small")
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState<"login" | "generate" | "import" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [progress, setProgress] = useState({ completed: 0, total: 0, label: "" })
  const [plan, setPlan] = useState<DemoPlan | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const logId = useRef(0)

  useEffect(() => {
    let cancelled = false
    fetch("/api/auth/session")
      .then((response) => response.json())
      .then((payload: ConnectedSession | { connected: false }) => {
        if (cancelled || !payload.connected) return
        setSession(payload)
        setInstanceUrl(payload.instanceUrl)
        setStep("profile")
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const preset = DEMO_PRESETS[presetId]
  const selectedTemplate = templates.findIndex((template) => template === profile.trim())

  function pushLog(level: LogLine["level"], message: string) {
    logId.current += 1
    const id = logId.current
    setLogs((current) => [...current, { id, level, message }])
  }

  function resetRun() {
    logId.current = 0
    setLogs([])
    setError(null)
    setSummary(null)
    setProgress({ completed: 0, total: 0, label: "" })
  }

  function onStreamEvent(event: StreamEvent) {
    if (event.type === "log") pushLog(event.level, event.message)
    if (event.type === "progress") setProgress(event)
    if (event.type === "plan") {
      setPlan(event.plan)
      saveProfileTemplate(submittedProfile.current)
    }
    if (event.type === "summary") setSummary(event.summary)
    if (event.type === "error") {
      setError(event.message)
      pushLog("error", event.message)
    }
  }

  async function login(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    setBusy("login")
    setError(null)
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceUrl, username, password }),
      })
      const payload = (await response.json()) as ConnectedSession & { error?: string }
      if (!response.ok || !payload.connected) {
        throw new Error(payload.error || "Anmeldung fehlgeschlagen.")
      }
      setSession(payload)
      setPassword("")
      setStep("profile")
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Anmeldung fehlgeschlagen.")
    } finally {
      setBusy(null)
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" })
    setSession(null)
    setPlan(null)
    setSummary(null)
    setStep("login")
  }

  async function generate() {
    submittedProfile.current = profile.trim()
    setBusy("generate")
    resetRun()
    setPlan(null)
    setStep("generate")
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          language,
          profile,
          presetId,
          apiKey: apiKey.trim() || undefined,
        }),
      })
      await readNdjson(response, onStreamEvent)
    } catch (generateError) {
      const message =
        generateError instanceof Error ? generateError.message : "Generierung fehlgeschlagen."
      setError(message)
      pushLog("error", message)
    } finally {
      setBusy(null)
    }
  }

  async function importPlan() {
    if (!plan) return
    setBusy("import")
    resetRun()
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(plan),
      })
      await readNdjson(response, onStreamEvent)
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : "Import fehlgeschlagen."
      setError(message)
      pushLog("error", message)
    } finally {
      setBusy(null)
    }
  }

  const percent =
    progress.total === 0 ? 0 : Math.round((progress.completed / progress.total) * 100)

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex flex-col gap-4 border-b px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Consolidate Demodaten</h1>
          <p className="text-sm text-muted-foreground">
            Branchenspezifische Beispieldaten erzeugen und in eine Instanz schreiben.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={session ? "default" : "secondary"}>
            {session ? session.displayName || session.username : "Nicht verbunden"}
          </Badge>
          {session ? (
            <Button variant="outline" type="button" onClick={logout} disabled={busy !== null}>
              <LogOutIcon data-icon="inline-start" />
              Trennen
            </Button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
        <div className="flex flex-wrap gap-2">
          {STEPS.map((item, index) => (
            <Button
              key={item.id}
              type="button"
              variant={step === item.id ? "default" : "outline"}
              disabled={item.id !== "login" && !session}
              onClick={() => setStep(item.id)}
            >
              {index + 1}. {item.label}
            </Button>
          ))}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Der Schritt ist fehlgeschlagen</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {step === "login" ? (
          <Card>
            <CardHeader>
              <CardTitle>Verbindung und Anmeldung</CardTitle>
              <CardDescription>
                Die Anmeldung läuft über die Consolidate-Sitzung. Das Cookie bleibt auf diesem Server,
                der Browser spricht nur mit dieser Anwendung.
              </CardDescription>
            </CardHeader>
            <form onSubmit={login}>
              <CardContent>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="instance-url">Instanz-URL</FieldLabel>
                    <Input
                      id="instance-url"
                      value={instanceUrl}
                      onChange={(event) => setInstanceUrl(event.target.value)}
                      autoComplete="url"
                      required
                    />
                    <FieldDescription>
                      GraphQL-Endpunkt. Eine Instanz-Adresse ohne /graphql wird ergänzt.
                    </FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="username">Admin-Benutzername oder E-Mail</FieldLabel>
                    <Input
                      id="username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      autoComplete="username"
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="password">Passwort</FieldLabel>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="current-password"
                      required
                    />
                  </Field>
                </FieldGroup>
              </CardContent>
              <CardFooter>
                <Button type="submit" disabled={busy !== null}>
                  {busy === "login" ? <Spinner data-icon="inline-start" /> : <LogInIcon data-icon="inline-start" />}
                  Verbinden und anmelden
                </Button>
              </CardFooter>
            </form>
          </Card>
        ) : null}

        {step === "profile" ? (
          <Card>
            <CardHeader>
              <CardTitle>Kundenprofil</CardTitle>
              <CardDescription>
                Projekt- und Aufgabentypen werden aus diesem Branchenprofil abgeleitet. Jeder
                Aufgabentyp bekommt passende Zusatzfelder. Einige Typen bekommen eigene Statuswerte,
                die auf dem Kanban des Projekts die Spalten bilden.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel>Zielsprache</FieldLabel>
                  <ToggleGroup
                    variant="outline"
                    spacing={0}
                    value={[language]}
                    onValueChange={(value) => {
                      const next = value[0]
                      if (next === "de" || next === "en") setLanguage(next)
                    }}
                  >
                    <ToggleGroupItem value="de">Deutsch</ToggleGroupItem>
                    <ToggleGroupItem value="en">Englisch</ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription>
                    Namen, Unternehmen, Titel, Beschreibungen und Termine entstehen in dieser Sprache.
                  </FieldDescription>
                </Field>
                <Field data-invalid={profile.trim().length > 0 && profile.trim().length < 20 ? true : undefined}>
                  <FieldLabel htmlFor="profile">Customer Profile</FieldLabel>
                  {templates.length > 0 ? (
                    <Select
                      items={templates.map((template, index) => ({
                        value: String(index),
                        label: profileTemplateLabel(template),
                      }))}
                      value={selectedTemplate >= 0 ? String(selectedTemplate) : null}
                      onValueChange={(value) => {
                        if (typeof value !== "string") return
                        const next = templates[Number(value)]
                        if (next) setProfile(next)
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Vorlage wählen" />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          {templates.map((template, index) => (
                            <SelectItem key={template} value={String(index)}>
                              {profileTemplateLabel(template)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  ) : null}
                  <Textarea
                    id="profile"
                    value={profile}
                    onChange={(event) => setProfile(event.target.value)}
                    placeholder={PROFILE_PLACEHOLDER}
                    rows={5}
                    aria-invalid={profile.trim().length > 0 && profile.trim().length < 20 ? true : undefined}
                  />
                  {profile.trim().length > 0 && profile.trim().length < 20 ? (
                    <FieldError>Mindestens 20 Zeichen, damit die Branche erkennbar ist.</FieldError>
                  ) : (
                    <FieldDescription>
                      Branche, Größe und Arbeitsweise. Daraus entstehen die Typen und die Beispiele.
                      Erzeugte Vorschauen bleiben hier als Vorlage erhalten.
                    </FieldDescription>
                  )}
                </Field>
                <Field>
                  <FieldLabel>Demo-Größe</FieldLabel>
                  <ToggleGroup
                    variant="outline"
                    spacing={0}
                    value={[presetId]}
                    onValueChange={(value) => {
                      const next = value[0]
                      if (next === "small" || next === "medium" || next === "large") setPresetId(next)
                    }}
                  >
                    <ToggleGroupItem value="small">Klein · 5</ToggleGroupItem>
                    <ToggleGroupItem value="medium">Mittel · 50</ToggleGroupItem>
                    <ToggleGroupItem value="large">Groß · 500</ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription>
                    Die Zahl ist die Aufgabenmenge. Teams, Mitarbeiter, Projekte und Termine werden dazu
                    passend gesetzt, damit Zuordnungen realistisch bleiben.
                  </FieldDescription>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{preset.companies} Unternehmen</Badge>
                    <Badge variant="outline">{preset.contacts} Kontakte</Badge>
                    <Badge variant="outline">{preset.teams} Teams</Badge>
                    <Badge variant="outline">{preset.employees} Mitarbeiter</Badge>
                    <Badge variant="outline">{preset.projects} Projekte</Badge>
                    <Badge variant="outline">{preset.tasks} Aufgaben</Badge>
                    <Badge variant="outline">{preset.appointments} Termine</Badge>
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor="api-key">OpenAI API-Key</FieldLabel>
                  <Input
                    id="api-key"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="off"
                    placeholder="sk-…"
                  />
                  <FieldDescription>
                    Optional, wenn OPENAI_API_KEY bereits in der Umgebung steht. Der Key wird nicht
                    gespeichert.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter>
              <Button type="button" onClick={generate} disabled={busy !== null || profile.trim().length < 20}>
                {busy === "generate" ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
                Vorschau erzeugen
              </Button>
            </CardFooter>
          </Card>
        ) : null}

        {step === "generate" ? (
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Generierung und Import</CardTitle>
                <CardDescription>
                  Zuerst die Vorschau prüfen, danach schreibt der Import Typen mit Zusatzfeldern und
                  Statuswerten, Unternehmen, Kontakte, Teams, Mitarbeiter, Projekte, Aufgaben und Termine.
                  Etwa jede fünfte Aufgabe enthält ein PDF oder Word-Dokument, ein Teil davon in zwei oder drei Versionen.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span>{progress.label || "Bereit"}</span>
                    <span className="text-muted-foreground">
                      {progress.completed}/{progress.total || 0}
                    </span>
                  </div>
                  <Progress value={percent} />
                </div>
                <ActivityLog lines={logs} />
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={generate}
                  disabled={busy !== null || profile.trim().length < 20}
                >
                  {busy === "generate" ? <Spinner data-icon="inline-start" /> : null}
                  Vorschau neu erzeugen
                </Button>
                <Button type="button" onClick={importPlan} disabled={busy !== null || !plan}>
                  {busy === "import" ? <Spinner data-icon="inline-start" /> : null}
                  In Consolidate anlegen
                </Button>
              </CardFooter>
            </Card>

            {plan ? (
              <Card>
                <CardHeader>
                  <CardTitle>Vorschau</CardTitle>
                  <CardDescription>
                    {plan.projectTypes.length} Projekt-Typen, {plan.taskTypes.length} Aufgaben-Typen,{" "}
                    {plan.companies.length} Unternehmen, {plan.contacts.length} Kontakte, {plan.teams.length}{" "}
                    Teams, {plan.employees.length} Mitarbeiter, {plan.projects.length} Projekte,{" "}
                    {plan.tasks.length} Aufgaben, {plan.appointments.length} Termine.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <PlanPreview plan={plan} />
                </CardContent>
              </Card>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Noch keine Vorschau</EmptyTitle>
                  <EmptyDescription>
                    Erzeuge die Daten aus dem Kundenprofil. Der Import startet erst nach der Prüfung.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {summary ? (
              <Card>
                <CardHeader>
                  <CardTitle>Ergebnis</CardTitle>
                  <CardDescription>
                    Demo-Benutzer verwenden das Passwort {summary.demoPassword}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{summary.projectTypes} Projekt-Typen</Badge>
                    <Badge variant="outline">{summary.taskTypes} Aufgaben-Typen</Badge>
                    <Badge variant="outline">{summary.companies} Unternehmen</Badge>
                    <Badge variant="outline">{summary.contacts} Kontakte</Badge>
                    <Badge variant="outline">{summary.teams} Teams</Badge>
                    <Badge variant="outline">{summary.employees} Mitarbeiter</Badge>
                    <Badge variant="outline">{summary.projects} Projekte</Badge>
                    <Badge variant="outline">{summary.tasks} Aufgaben</Badge>
                    <Badge variant="outline">{summary.appointments} Termine</Badge>
                    {summary.failed > 0 ? (
                      <Badge variant="destructive">{summary.failed} fehlgeschlagen</Badge>
                    ) : null}
                  </div>
                  <Separator />
                  <Button
                    render={
                      <a href={summary.appUrl} target="_blank" rel="noreferrer" />
                    }
                  >
                    Instanz öffnen
                  </Button>
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}
      </main>
    </div>
  )
}
