import type { Extensions, JSONContent } from '@tiptap/core';
export type { JSONContent };
export const extensions: Extensions;
export function validateDoc(input: unknown): JSONContent;
export function readKnowledgeBody(input: unknown): { doc: JSONContent; body: string };
export function allowedURL(href: unknown): boolean;
