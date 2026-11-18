import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import type { PersonGender } from "@/lib/demo-plan"

export type AvatarPicture = {
  filename: string
  contentType: "image/webp"
  body: Buffer
}

let cached: Record<PersonGender, AvatarPicture[]> | undefined

function loadFolder(gender: PersonGender): AvatarPicture[] {
  const directory = path.join(process.cwd(), "assets", "avatars", gender)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    throw new Error(`Der Avatar-Ordner „${gender}“ fehlt.`)
  }
  const pictures = names
    .filter((name) => name.toLowerCase().endsWith(".webp"))
    .map((filename) => ({
      filename,
      contentType: "image/webp" as const,
      body: readFileSync(path.join(directory, filename)),
    }))
  if (pictures.length === 0) throw new Error(`Der Avatar-Ordner „${gender}“ enthält keine Bilder.`)
  return pictures
}

function folders(): Record<PersonGender, AvatarPicture[]> {
  cached ??= {
    male: loadFolder("male"),
    female: loadFolder("female"),
    neutral: loadFolder("neutral"),
  }
  return cached
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    const current = copy[index]
    copy[index] = copy[swap]
    copy[swap] = current
  }
  return copy
}

export function createAvatarDeck() {
  const source = folders()
  const remaining: Record<PersonGender, AvatarPicture[]> = {
    male: shuffle(source.male),
    female: shuffle(source.female),
    neutral: shuffle(source.neutral),
  }
  const used = new Set<string>()

  return {
    take(gender: PersonGender): AvatarPicture | undefined {
      while (remaining[gender].length > 0) {
        const picture = remaining[gender].pop()
        if (!picture) break
        const key = `${gender}/${picture.filename}`
        if (used.has(key)) continue
        used.add(key)
        return picture
      }
      return undefined
    },
  }
}

export type AvatarDeck = ReturnType<typeof createAvatarDeck>

export function avatarFolderCounts(): Record<PersonGender, number> {
  const source = folders()
  return {
    male: source.male.length,
    female: source.female.length,
    neutral: source.neutral.length,
  }
}
