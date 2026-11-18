import sharp from "sharp"

const LOGO_URL = "https://logoipsum.com/api/logos?from=0&to=300"
const LOGO_SIZE = 256

type LogoRecord = {
  id?: number
  code?: string
}

let catalog: Promise<Buffer[]> | undefined

export async function fetchCompanyLogo(index: number): Promise<Buffer> {
  catalog ??= loadCatalog()
  const logos = await catalog
  if (logos.length === 0) throw new Error("Logoipsum hat keine Logos geliefert.")
  const logo = logos[Math.abs(index) % logos.length]
  if (!logo) throw new Error("Logoipsum hat keine Logos geliefert.")
  return logo
}

async function loadCatalog(): Promise<Buffer[]> {
  const response = await fetch(LOGO_URL, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Die Logoquelle ist nicht erreichbar (HTTP ${response.status}).`)
  const rows = (await response.json()) as LogoRecord[]
  if (!Array.isArray(rows)) throw new Error("Die Logoquelle hat keine Liste geliefert.")

  const marks = rows.filter((row) => typeof row.code === "string" && isCompactMark(row.code))
  const chosen = marks.length > 0 ? marks : rows.filter((row) => typeof row.code === "string")
  const logos: Buffer[] = []
  for (const row of chosen) {
    try {
      logos.push(await optimizeLogo(row.code!))
    } catch {
      continue
    }
  }
  return logos
}

function isCompactMark(svg: string): boolean {
  const box = svg.match(/viewBox="\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*"/i)
  if (!box) return false
  const ratio = Number(box[1]) / Number(box[2])
  if (!Number.isFinite(ratio) || ratio < 0.65 || ratio > 1.7) return false
  const fills = [...svg.matchAll(/fill="(#[0-9a-fA-F]{3,8})"/g)].map((match) => match[1].toLowerCase())
  return fills.some((fill) => fill !== "#fff" && fill !== "#ffffff")
}

export async function optimizeLogo(svg: string): Promise<Buffer> {
  const inner = LOGO_SIZE - 36
  const rendered = await sharp(Buffer.from(svg), { density: 300 })
    .resize(inner, inner, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
  return sharp(rendered)
    .extend({
      top: 18,
      bottom: 18,
      left: 18,
      right: 18,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
}
