import { defineTool, type ToolDefinition } from '@flue/runtime'
import * as v from 'valibot'
import { cap, clientOf, type ToolDeps } from './kit.ts'

const MAX_FIELDS = 100
/** Option-backed fields can have long value lists; the names are the useful part. */
const MAX_VALUES_PER_FIELD = 25

/**
 * The custom fields this account defines.
 *
 * Thin over the endpoint, and worth a tool anyway: custom fields are addressed as
 * `custom_<uuid>` in every `fields` and `search` parameter, and a model has no
 * other way to learn that mapping. Without it, any question that touches an
 * account-specific field is unanswerable.
 *
 * It is also the discovery step for anything built on top — a compliance or
 * credential-tracking layer needs the id behind a human field name, and this is
 * where that comes from.
 */
export function listCustomFields(deps: ToolDeps): ToolDefinition {
  const getClient = clientOf(deps)

  return defineTool({
    name: 'list_custom_fields',
    description:
      'List the custom person fields this Elvanto account defines, with the ' +
      'custom_<uuid> key each one is addressed by. Call this before requesting or ' +
      'searching a custom field — the keys are account-specific and cannot be ' +
      'guessed. Returns the field name, its type, and the allowed values for ' +
      'option-backed fields.',
    input: v.object({
      name: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.description('Only fields whose name contains this text, case-insensitive.'),
        ),
      ),
    }),
    async run({ data, log, signal }) {
      const page = await getClient().people.customFields.getAll(signal ? { signal } : {})
      const needle = data.name?.toLowerCase()

      const fields = page.items
        .filter((field) => !needle || field.name?.toLowerCase().includes(needle))
        .map((field) => ({
          // The key, not just the id: this is the string that goes into `fields`
          // and `search`, and the difference is the whole reason to call this.
          key: `custom_${field.id}`,
          id: field.id,
          name: field.name,
          type: field.type,
          ...(field.values?.length
            ? {
                values: field.values
                  .slice(0, MAX_VALUES_PER_FIELD)
                  .map((value) => value.name)
                  .filter(Boolean),
              }
            : {}),
        }))

      const capped = cap(fields, MAX_FIELDS, 'Filter by name to see the rest.')
      log.info(`list_custom_fields: ${capped.items.length} field(s)`)

      return {
        output: {
          count: capped.items.length,
          fields: capped.items,
          ...(capped.truncated ? { truncated: capped.truncated } : {}),
        },
      }
    },
  })
}
