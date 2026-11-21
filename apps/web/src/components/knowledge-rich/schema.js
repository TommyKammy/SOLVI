import { extensions as shared } from '@solvi/shared/knowledge-schema';
import { getSchema } from '@tiptap/core';
import { editableTable } from './article-table';
export { allowedURL, validateDoc } from '@solvi/shared/knowledge-schema';
export const extensions = shared.map((ext) => (ext.name === 'table' ? editableTable : ext));
export const schema = getSchema(extensions);
