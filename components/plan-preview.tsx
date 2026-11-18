"use client"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { DemoPlan } from "@/lib/demo-plan"
import { genderLabel, inferPersonGender } from "@/lib/person-gender"

export function PlanPreview({
  plan,
  adminName,
}: {
  plan: DemoPlan
  adminName: string
}) {
  return (
    <Tabs defaultValue="types">
      <TabsList>
        <TabsTrigger value="types">Konfiguration</TabsTrigger>
        <TabsTrigger value="accounts">Unternehmen</TabsTrigger>
        <TabsTrigger value="people">Teams und Mitarbeiter</TabsTrigger>
        <TabsTrigger value="projects">Projekte</TabsTrigger>
        <TabsTrigger value="tasks">Aufgaben</TabsTrigger>
        <TabsTrigger value="appointments">Termine</TabsTrigger>
      </TabsList>
      <TabsContent value="types" className="pt-3">
        <div className="flex flex-col gap-4">
          <TypeTable title="Projekt-Typen" rows={plan.projectTypes} />
          <TypeTable title="Aufgaben-Typen" rows={plan.taskTypes} />
        </div>
      </TabsContent>
      <TabsContent value="accounts" className="pt-3">
        <div className="flex max-h-96 flex-col gap-4 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unternehmen</TableHead>
                <TableHead>Ort</TableHead>
                <TableHead>Bezug</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.companies.map((company) => (
                <TableRow key={company.email}>
                  <TableCell>{company.name}</TableCell>
                  <TableCell>
                    {company.zipCode} {company.city}
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-xs truncate">{company.note}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kontakt</TableHead>
                <TableHead>Geschlecht</TableHead>
                <TableHead>Rolle</TableHead>
                <TableHead>Unternehmen</TableHead>
                <TableHead>E-Mail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.contacts.map((contact) => (
                <TableRow key={contact.email}>
                  <TableCell>
                    {contact.firstName} {contact.lastName}
                  </TableCell>
                  <TableCell>{genderLabel(contact.gender ?? inferPersonGender(contact.firstName))}</TableCell>
                  <TableCell>{contact.position}</TableCell>
                  <TableCell>{plan.companies[contact.companyIndex]?.name}</TableCell>
                  <TableCell>{contact.email}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TabsContent>
      <TabsContent value="people" className="pt-3">
        <div className="flex max-h-96 flex-col gap-4 overflow-auto">
          <div className="flex flex-wrap gap-2">
            {plan.teams.map((team) => (
              <Badge key={team.name} variant="outline">
                {team.name}
              </Badge>
            ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Geschlecht</TableHead>
                <TableHead>Rolle</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>E-Mail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.employees.map((employee) => (
                <TableRow key={employee.email}>
                  <TableCell>
                    {employee.firstName} {employee.lastName}
                  </TableCell>
                  <TableCell>{genderLabel(employee.gender ?? inferPersonGender(employee.firstName))}</TableCell>
                  <TableCell>{employee.position}</TableCell>
                  <TableCell>{plan.teams[employee.teamIndex]?.name}</TableCell>
                  <TableCell>{employee.email}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </TabsContent>
      <TabsContent value="projects" className="max-h-96 overflow-auto pt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Projekt</TableHead>
              <TableHead>Typ</TableHead>
              <TableHead>Aufgaben-Typ</TableHead>
              <TableHead>Leitung</TableHead>
              <TableHead>Zeitraum</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.projects.map((project) => {
              const manager = plan.employees[project.managerIndex]
              return (
                <TableRow key={project.name}>
                  <TableCell>
                    <span className="block max-w-xs truncate">{project.name}</span>
                  </TableCell>
                  <TableCell>{plan.projectTypes[project.projectTypeIndex]?.displayName}</TableCell>
                  <TableCell>{plan.taskTypes[project.taskTypeIndex]?.displayName}</TableCell>
                  <TableCell>
                    {manager ? `${manager.firstName} ${manager.lastName}` : ""}
                  </TableCell>
                  <TableCell>
                    {project.startDate} – {project.endDate}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </TabsContent>
      <TabsContent value="tasks" className="max-h-96 overflow-auto pt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Aufgabe</TableHead>
              <TableHead>Typ</TableHead>
              <TableHead>Projekt</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Zeitraum</TableHead>
              <TableHead>Verantwortlich</TableHead>
              <TableHead>Datei</TableHead>
              <TableHead>Felder</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.tasks.map((task, index) => (
              <TableRow key={`${task.subject}-${index}`}>
                <TableCell>
                  <span className="block max-w-xs truncate">{task.subject}</span>
                </TableCell>
                <TableCell>{plan.taskTypes[task.taskTypeIndex]?.displayName}</TableCell>
                <TableCell>
                  <span className="block max-w-xs truncate">
                    {plan.projects[task.projectIndex]?.name}
                  </span>
                </TableCell>
                <TableCell>{task.statusName || task.statusCategory}</TableCell>
                <TableCell>
                  {task.startDate} – {task.dueDate}
                </TableCell>
                <TableCell>
                  {task.assignToAdmin
                    ? adminName
                    : `${plan.employees[task.assigneeIndex]?.firstName ?? ""} ${plan.employees[task.assigneeIndex]?.lastName ?? ""}`.trim()}
                </TableCell>
                <TableCell>
                  {task.file
                    ? task.file.versions > 1
                      ? `${task.file.name} · ${task.file.versions} Versionen`
                      : task.file.name
                    : ""}
                </TableCell>
                <TableCell>
                  <span className="block max-w-sm truncate">
                    {task.fieldValues
                      .map((entry) => {
                        const label = plan.taskTypes[task.taskTypeIndex]?.fields.find(
                          (field) => field.key === entry.key
                        )?.label
                        return `${label ?? entry.key}: ${entry.value}`
                      })
                      .join(", ")}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TabsContent>
      <TabsContent value="appointments" className="max-h-96 overflow-auto pt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Termin</TableHead>
              <TableHead>Projekt</TableHead>
              <TableHead>Wann</TableHead>
              <TableHead>Ort</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.appointments.map((appointment, index) => (
              <TableRow key={`${appointment.title}-${index}`}>
                <TableCell>
                  <span className="block max-w-xs truncate">{appointment.title}</span>
                </TableCell>
                <TableCell>
                  <span className="block max-w-xs truncate">
                    {plan.projects[appointment.projectIndex]?.name}
                  </span>
                </TableCell>
                <TableCell>
                  {appointment.startDate} {appointment.startTime.slice(0, 5)}
                </TableCell>
                <TableCell>
                  <span className="block max-w-xs truncate">{appointment.location}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TabsContent>
    </Tabs>
  )
}

function TypeTable({
  title,
  rows,
}: {
  title: string
  rows: {
    displayName: string
    rationale: string
    fields?: { label: string; valueType: string }[]
    statuses?: { name: string }[]
  }[]
}) {
  const showFields = rows.some((row) => (row.fields?.length ?? 0) > 0)
  const showStatuses = rows.some((row) => (row.statuses?.length ?? 0) > 0)
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Warum dieser Typ</TableHead>
            {showFields ? <TableHead>Zusatzfelder</TableHead> : null}
            {showStatuses ? <TableHead>Kanban</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.displayName}>
              <TableCell>{row.displayName}</TableCell>
              <TableCell>
                <span className="block max-w-xl truncate">{row.rationale}</span>
              </TableCell>
              {showFields ? (
                <TableCell>
                  <span className="block max-w-sm truncate">
                    {row.fields?.map((field) => `${field.label} (${field.valueType})`).join(", ")}
                  </span>
                </TableCell>
              ) : null}
              {showStatuses ? (
                <TableCell>
                  <span className="block max-w-sm truncate">
                    {row.statuses?.map((status) => status.name).join(" → ")}
                  </span>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
