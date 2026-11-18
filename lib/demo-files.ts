export type DemoFileKind = "pdf" | "docx"

export type TaskFilePlan = {
  name: string
  kind: DemoFileKind
  versions: number
}

const PDF_TYPE = "application/pdf"
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export function assignTaskFiles<T extends { subject: string; file?: TaskFilePlan }>(tasks: T[]) {
  const count = tasks.length
  const withFile = Math.round(count * 0.2)
  if (withFile <= 0) return
  const versioned = Math.min(withFile, Math.max(withFile === 1 ? 1 : 0, Math.round(withFile * 0.3)))
  const chosen = spreadIndexes(count, withFile)
  const usedNames = new Set<string>()
  chosen.forEach((taskIndex, order) => {
    const kind: DemoFileKind = order % 2 === 0 ? "pdf" : "docx"
    const versions = order < versioned ? 2 + (order % 2) : 1
    tasks[taskIndex].file = {
      name: uniqueFileName(tasks[taskIndex].subject, kind, usedNames),
      kind,
      versions,
    }
  })
}

function spreadIndexes(count: number, picks: number): number[] {
  const indexes: number[] = []
  const step = count / picks
  for (let index = 0; index < picks; index += 1) {
    const taskIndex = Math.min(count - 1, Math.floor(index * step + step / 2))
    if (!indexes.includes(taskIndex)) indexes.push(taskIndex)
  }
  for (let index = 0; indexes.length < picks && index < count; index += 1) {
    if (!indexes.includes(index)) indexes.push(index)
  }
  return indexes
}

function uniqueFileName(subject: string, kind: DemoFileKind, used: Set<string>): string {
  const stem =
    subject
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50) || "Dokument"
  let name = `${stem}.${kind}`
  let suffix = 2
  while (used.has(name.toLowerCase())) {
    name = `${stem} ${suffix}.${kind}`
    suffix += 1
  }
  used.add(name.toLowerCase())
  return name
}

export function buildTaskDocument(input: {
  kind: DemoFileKind
  title: string
  description: string
  version: number
  versions: number
  language: "de" | "en"
}): { body: Buffer; contentType: string } {
  const lines = documentLines(input)
  if (input.kind === "pdf") {
    return { body: buildPdf(lines), contentType: PDF_TYPE }
  }
  return { body: buildDocx(lines), contentType: DOCX_TYPE }
}

function documentLines(input: {
  title: string
  description: string
  version: number
  versions: number
  language: "de" | "en"
}): string[] {
  const versionLabel =
    input.language === "de"
      ? `Version ${input.version} von ${input.versions}`
      : `Version ${input.version} of ${input.versions}`
  const note =
    input.version === 1
      ? input.language === "de"
        ? "Erste Fassung zum Auftrag."
        : "First draft for this task."
      : input.version === input.versions
        ? input.language === "de"
          ? "Abgestimmte Fassung."
          : "Agreed revision."
        : input.language === "de"
          ? "Ergänzte Fassung."
          : "Updated revision."
  return [input.title, versionLabel, note, ...wrapText(input.description, 90)]
}

function wrapText(value: string, width: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > width && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, 18)
}

function buildPdf(lines: string[]): Buffer {
  const commands = ["BT", "/F1 12 Tf", "56 780 Td"]
  lines.forEach((line, index) => {
    if (index > 0) commands.push("0 -18 Td")
    commands.push(`(${pdfEscape(line)}) Tj`)
  })
  commands.push("ET")
  const stream = commands.join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "ascii"))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, "ascii")
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index < offsets.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(body, "ascii")
}

function pdfEscape(value: string): string {
  const winAnsi: Record<string, string> = {
    ä: "\\344",
    ö: "\\366",
    ü: "\\374",
    Ä: "\\304",
    Ö: "\\326",
    Ü: "\\334",
    ß: "\\337",
  }
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\n]/g, (char) => winAnsi[char] ?? (char.charCodeAt(0) > 126 ? "" : char))
}

function buildDocx(lines: string[]): Buffer {
  const paragraphs = lines
    .map(
      (line) =>
        `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`
    )
    .join("")
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
  ])
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8")
    const crc = crc32(file.data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, file.data)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(file.data.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + file.data.length
  }
  const centralOffset = offset
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
