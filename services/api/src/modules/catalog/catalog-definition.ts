import { Problems } from '@solvi/shared';
import {
  catalogDefinitionSchema,
  catalogFieldSchema,
  validateCatalogFieldValues,
  type CatalogDefinition,
  type CatalogValues,
} from '@solvi/shared/catalog';

export const fieldSchema = catalogFieldSchema;
export const definitionSchema = catalogDefinitionSchema;
export type Definition = CatalogDefinition;
export function validateValues(definition: Definition, values: CatalogValues = {}) {
  const result = validateCatalogFieldValues(definition, values);
  if (result.errors.length) throw Problems.validation(result.errors);
  return result.values;
}
