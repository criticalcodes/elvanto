import { z } from 'zod'
import {
  dateString,
  flag,
  id,
  reference,
  wrapped,
} from '../zod-helpers.js'

/**
 * A person.
 *
 * Only the documented default fields are always present; everything under
 * "optional fields" appears solely when named in the request's `fields`
 * parameter, so it is modelled as optional here. Custom fields arrive as
 * `custom_<uuid>` keys and are preserved by the loose object rather than
 * enumerated.
 */
export const personSchema = z.looseObject({
  id: id,

  // Default fields.
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  category_id: id.optional(),
  firstname: z.string().optional(),
  preferred_name: z.string().optional(),
  middle_name: z.string().optional(),
  lastname: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  admin: flag.optional(),
  archived: flag.optional(),
  contact: flag.optional(),
  volunteer: flag.optional(),
  deceased: flag.optional(),
  status: z.string().optional(),
  username: z.string().optional(),
  last_login: dateString.optional(),
  country: z.string().optional(),
  timezone: z.string().optional(),
  picture: z.string().optional(),
  family_id: id.optional(),
  family_relationship: z.string().optional(),

  // Optional fields.
  gender: z.string().optional(),
  birthday: dateString.optional(),
  anniversary: dateString.optional(),
  school_grade: z.string().optional(),
  marital_status: z.string().optional(),
  development_child: flag.optional(),
  special_needs_child: flag.optional(),
  security_code: z.string().optional(),
  receipt_name: z.string().optional(),
  giving_number: z.string().optional(),

  mailing_address: z.string().optional(),
  mailing_address2: z.string().optional(),
  mailing_city: z.string().optional(),
  mailing_state: z.string().optional(),
  mailing_postcode: z.string().optional(),
  mailing_country: z.string().optional(),
  home_address: z.string().optional(),
  home_address2: z.string().optional(),
  home_city: z.string().optional(),
  home_state: z.string().optional(),
  home_postcode: z.string().optional(),
  home_country: z.string().optional(),

  locations: wrapped('location', reference).optional(),
  // The singular keys and item shapes below are inferred: the documentation
  // names these fields but shows no populated example. `departments` and
  // `access_permissions` are written as plain strings ("Worship Team||Band||
  // Guitar"), so they may read back as bare strings rather than `{id, name}` —
  // which will surface as a validation error rather than silently empty data.
  // Verify with `pnpm smoke`.
  departments: wrapped('department', reference).optional(),
  demographics: wrapped('demographic', reference).optional(),
  service_types: wrapped('service_type', reference).optional(),
  access_permissions: wrapped('access_permission', reference).optional(),
  family: wrapped('person', reference).optional(),
  reports_to: z.string().optional(),
})

export type Person = z.output<typeof personSchema>

/** A person as embedded in another record (group member, volunteer, …). */
export const personReferenceSchema = z.looseObject({
  id: id,
  firstname: z.string().optional(),
  preferred_name: z.string().optional(),
  lastname: z.string().optional(),
  email: z.string().optional(),
  mobile: z.string().optional(),
  phone: z.string().optional(),
  picture: z.string().optional(),
})

export type PersonReference = z.output<typeof personReferenceSchema>

/** A people category — the "type" of person, e.g. Member or New Person. */
export const peopleCategorySchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  color: z.string().optional(),
})

export type PeopleCategory = z.output<typeof peopleCategorySchema>

/**
 * A custom field definition. `values` is present only for the option-backed
 * types such as `select_multi`.
 */
export const customFieldSchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  type: z.string().optional(),
  values: wrapped('value', reference).optional(),
})

export type CustomField = z.output<typeof customFieldSchema>
