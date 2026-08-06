import {
  parseElvantoDate,
  type Person,
  type PersonReference,
  type Service,
} from '@criticalcodes/elvanto'

/**
 * Reshaping Elvanto's records into the smallest thing that answers the question.
 *
 * The raw endpoints are faithful to Elvanto, which is the right call for a
 * library and the wrong one for a model's context: a person carries ~40 fields, a
 * service's volunteer roster is four levels of nesting, and a page of either
 * costs thousands of tokens to say something a sentence could. Everything here
 * exists to make one answer small.
 *
 * The other reason is privacy. A compact shape is also a deliberate one — these
 * functions name the fields that leave, so addresses, giving numbers, security
 * codes and custom fields cannot reach a durable agent transcript just because
 * they happened to be on the record.
 */

/** A person, reduced to what identifies and contacts them. */
export interface PersonCard {
  id: string
  name: string
  email?: string
  phone?: string
  /** Only when true — an absent flag reads as "no" and costs nothing to omit. */
  archived?: boolean
  volunteer?: boolean
}

/**
 * The name to show.
 *
 * Prefers `preferred_name` over `firstname`, because that is the point of the
 * field: someone recorded as Jonathan who goes by Josh should be called Josh.
 */
export function displayName(person: {
  firstname?: string
  preferred_name?: string
  lastname?: string
}): string {
  const given = person.preferred_name?.trim() || person.firstname?.trim() || ''
  const family = person.lastname?.trim() || ''
  const full = `${given} ${family}`.trim()
  return full || '(unnamed)'
}

export function personCard(person: Person | PersonReference): PersonCard {
  const card: PersonCard = { id: person.id, name: displayName(person) }
  if (person.email) card.email = person.email
  // One contact number, not two near-identical ones. Mobile first: it is the one
  // a roster coordinator actually uses.
  const phone = person.mobile?.trim() || person.phone?.trim()
  if (phone) card.phone = phone
  if ('archived' in person && person.archived) card.archived = true
  if ('volunteer' in person && person.volunteer) card.volunteer = true
  return card
}

/** One person's assignment to a position, flattened out of the volunteers tree. */
export interface RosterEntry {
  department?: string
  subDepartment?: string
  position?: string
  person: PersonCard
  /** Elvanto's own wording — "Confirmed", "Unconfirmed", … — passed through. */
  status?: string
}

/**
 * Flattens `service.volunteers` into one row per scheduled person.
 *
 * Elvanto nests this four deep — plan (per service time) → position → volunteer →
 * person — and keys the outer level `plan`, the same word it uses for running
 * sheets, which are unrelated. Reading that structure is most of the work in
 * answering "who is on this Sunday", so it happens once, here.
 */
export function rosterEntries(service: Service): RosterEntry[] {
  const entries: RosterEntry[] = []

  for (const plan of service.volunteers ?? []) {
    for (const position of plan.positions ?? []) {
      for (const scheduled of position.volunteers ?? []) {
        if (!scheduled.person) continue
        const entry: RosterEntry = { person: personCard(scheduled.person) }
        if (position.department_name) entry.department = position.department_name
        if (position.sub_department_name) entry.subDepartment = position.sub_department_name
        if (position.position_name) entry.position = position.position_name
        if (scheduled.status) entry.status = scheduled.status
        entries.push(entry)
      }
    }
  }

  return entries
}

/**
 * How many positions the service defines, filled or not.
 *
 * Needed because "nobody is serving" and "the roster has not been built yet" look
 * identical from the entries alone, and they mean opposite things to whoever
 * asked. A live account showed a service with 42 defined positions and zero people
 * assigned to any of them; reporting that as `0` and nothing else would invite the
 * reader to conclude the service needs no volunteers.
 */
export function countPositions(service: Service): number {
  let total = 0
  for (const plan of service.volunteers ?? []) total += (plan.positions ?? []).length
  return total
}

/** A service, identified without its contents. */
export interface ServiceHeader {
  id: string
  name?: string
  date?: string
  type?: string
  location?: string
  /** Elvanto's numeric state, translated only here: 1 published, 0 draft. */
  status?: 'published' | 'draft'
}

export function serviceHeader(service: Service): ServiceHeader {
  const header: ServiceHeader = { id: service.id }
  if (service.name) header.name = service.name
  if (service.date) header.date = service.date
  // Elvanto returns `{ id: "", name: "" }` rather than omitting an unset
  // reference, so the name has to be checked as well as the object — otherwise
  // every service without a type carries `type: ""`, which reads as a value.
  if (service.service_type && typeof service.service_type === 'object' && service.service_type.name) {
    header.type = service.service_type.name
  }
  if (service.location && typeof service.location === 'object' && service.location.name) {
    header.location = service.location.name
  }
  // Only the two documented values are translated. Anything else is left off
  // rather than guessed at — inventing a label for an unknown state would be
  // worse than saying nothing.
  if (service.status === 1) header.status = 'published'
  else if (service.status === 0) header.status = 'draft'
  return header
}

/** `YYYY-MM-DD`, which is the only date format Elvanto's filters accept. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Adds days without mutating, and without a date library. */
export function addDays(date: Date, days: number): Date {
  const out = new Date(date.getTime())
  out.setUTCDate(out.getUTCDate() + days)
  return out
}

/**
 * Elvanto's date strings compare correctly as strings — they are zero-padded and
 * most-significant-first — so ordering needs no parsing. Parsing is reserved for
 * arithmetic, where {@link parseElvantoDate} knows the values are UTC despite
 * carrying no zone marker.
 */
export function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return a >= b ? a : b
}

/** Whole days from `from` to `to`, negative when `to` is in the past. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

export { parseElvantoDate }
