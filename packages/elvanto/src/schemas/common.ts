import { z } from 'zod'
import { id, reference, wrapped } from '../zod-helpers.js'

/**
 * Organisational structures shared by people, groups and services.
 *
 * Elvanto nests these one level deeper than a plain reference: a department
 * carries its sub-departments, and a demographic its sub-demographics — each in
 * the usual singular-key wrapper, which is flattened here like any other.
 *
 * Confirmed against a live account. The documentation names the fields but shows
 * no populated example.
 */

/**
 * A sub-department or sub-demographic.
 *
 * Modelled tolerantly: a live account confirmed the wrapper exists, but the
 * member shape has not been observed directly, and Elvanto writes these as bare
 * names elsewhere. Narrow once a sweep shows which form is returned.
 */
const subEntry = z.union([reference, z.string()])

/** A department, with its sub-departments. */
export const departmentSchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  sub_departments: wrapped('sub_department', subEntry).optional(),
})

export type Department = z.output<typeof departmentSchema>

/** A demographic, with its sub-demographics. */
export const demographicSchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  sub_demographics: wrapped('sub_demographic', subEntry).optional(),
})

export type Demographic = z.output<typeof demographicSchema>
