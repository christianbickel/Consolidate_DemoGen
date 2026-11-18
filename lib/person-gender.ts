import type { PersonGender } from "@/lib/demo-plan"

const NEUTRAL = new Set(
  "alex,andi,avery,bailey,blake,cameron,casey,charlie,drew,eden,jamie,jesse,jordan,kai,kelly,kim,kris,lennox,luca,mika,noa,parker,phoenix,quinn,remy,rene,riley,robin,rory,rowan,sam,sascha,sasha,skyler,taylor,toni".split(
    ","
  )
)

const MALE = new Set(
  "alexander,andreas,anton,ben,benjamin,bernd,christian,daniel,david,dennis,dieter,elias,emil,erik,fabian,felix,finn,florian,frank,hans,helmut,holger,jan,johannes,john,jonas,julian,jorg,jurgen,kevin,klaus,leon,linus,liam,luis,lukas,marcel,marco,markus,martin,matteo,matthias,max,maximilian,michael,moritz,niklas,noah,oliver,oskar,patrick,paul,peter,philipp,ralf,sebastian,simon,stefan,sven,theo,thomas,tim,tobias,uwe,wolfgang".split(
    ","
  )
)

const FEMALE = new Set(
  "anna,annika,birgit,claudia,elena,elisa,emma,hannah,helen,helena,ines,jana,julia,johanna,katharina,katrin,laura,lea,lena,lisa,luisa,marie,melanie,mia,nadine,nicole,petra,sabine,sandra,sarah,sophie,stefanie,svenja,vanessa".split(
    ","
  )
)

const SALUTATION_WORDS: Record<PersonGender, string[]> = {
  male: ["herr", "mr", "mister", "male", "male_form", "männlich", "mann"],
  female: ["frau", "mrs", "ms", "miss", "female", "female_form", "weiblich"],
  neutral: ["neutral", "neutral_form", "divers", "diverse", "mx", "non-binary", "nonbinary"],
}

export function inferPersonGender(firstName: string): PersonGender {
  const name = firstName
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[\s-]/)[0]
  if (!name) return "neutral"
  if (NEUTRAL.has(name)) return "neutral"
  if (MALE.has(name)) return "male"
  if (FEMALE.has(name)) return "female"
  if (/(a|ine|ina|elle|ette|ie)$/.test(name)) return "female"
  return "male"
}

export function genderLabel(gender: PersonGender): string {
  if (gender === "male") return "männlich"
  if (gender === "female") return "weiblich"
  return "neutral"
}

export function genderAdjective(gender: PersonGender): string {
  if (gender === "male") return "männliches"
  if (gender === "female") return "weibliches"
  return "neutrales"
}

export function matchSalutationValue(
  options: { id: number; value: string }[],
  gender: PersonGender
): string | undefined {
  const words = SALUTATION_WORDS[gender]
  const found = options.find((option) => {
    const value = option.value.trim().toLowerCase().replace(/\.$/, "")
    return words.some(
      (word) => value === word || value.startsWith(`${word} `) || value.startsWith(`${word} (`)
    )
  })
  return found?.value
}

export function matchSalutationId(
  options: { id: number; value: string }[],
  gender: PersonGender
): number | undefined {
  const value = matchSalutationValue(options, gender)
  return options.find((option) => option.value === value)?.id
}
