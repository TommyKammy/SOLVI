import type { CatalogField, CatalogSection } from '@solvi/shared/catalog';
import type { CatalogItem } from './api';

export type CatalogInitialContent = {
  title: string;
  description: string;
  definition: CatalogItem['definition'];
};

/** A clone is an unsaved independent form, with responsibility returned to its creator. */
export function cloneCatalogContent(
  content: CatalogInitialContent,
  viewerId: string,
): CatalogInitialContent {
  const copy = {
    title: content.title,
    description: content.description,
    definition: structuredClone(content.definition),
  };
  if (viewerId) copy.definition.ownerId = viewerId;
  else delete copy.definition.ownerId;
  return copy;
}

export function appendCatalogQuestionSet(
  current: { fields: CatalogField[]; sections: CatalogSection[] },
  questionSet: { fields: CatalogField[]; sections?: CatalogSection[] },
  createKey = (kind: 'field' | 'section') =>
    `${kind}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
):
  | { ok: true; fields: CatalogField[]; sections: CatalogSection[] }
  | { ok: false; message: string } {
  const sections = questionSet.sections ?? [];
  if (current.fields.length + questionSet.fields.length > 10)
    return {
      ok: false,
      message: `質問は最大10件です。あと${Math.max(0, 10 - current.fields.length)}件まで追加できます。`,
    };
  if (current.sections.length + sections.length > 10)
    return {
      ok: false,
      message: 'セクションは最大10件です。現在のセクションを整理してから追加してください。',
    };
  const fieldKeys = new Set(questionSet.fields.map((field) => field.key));
  const sectionKeys = new Set(sections.map((section) => section.key));
  if (
    fieldKeys.size !== questionSet.fields.length ||
    sectionKeys.size !== sections.length ||
    questionSet.fields.some(
      (field) =>
        (field.section && !sectionKeys.has(field.section)) ||
        (field.visibleWhen && !fieldKeys.has(field.visibleWhen.field)),
    )
  )
    return {
      ok: false,
      message: '質問セットの参照を確認できません。最新の質問セットを読み直してください。',
    };
  const used = new Set([...current.fields, ...current.sections].map((entry) => entry.key));
  const keyMap = (keys: Iterable<string>, kind: 'field' | 'section') => {
    const map = new Map<string, string>();
    for (const oldKey of keys) {
      let key = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = createKey(kind);
        if (
          /^[a-z][a-z0-9_]{0,31}$/.test(candidate) &&
          !['constructor', 'prototype', '__proto__'].includes(candidate) &&
          !used.has(candidate)
        ) {
          key = candidate;
          break;
        }
      }
      if (!key) return null;
      used.add(key);
      map.set(oldKey, key);
    }
    return map;
  };
  const fieldsMap = keyMap(fieldKeys, 'field');
  const sectionsMap = keyMap(sectionKeys, 'section');
  if (!fieldsMap || !sectionsMap)
    return {
      ok: false,
      message: '質問の保存キーを割り当てられませんでした。もう一度追加してください。',
    };
  const copied = structuredClone(questionSet.fields).map((field) => ({
    ...field,
    key: fieldsMap.get(field.key)!,
    ...(field.section ? { section: sectionsMap.get(field.section)! } : {}),
    ...(field.visibleWhen
      ? { visibleWhen: { ...field.visibleWhen, field: fieldsMap.get(field.visibleWhen.field)! } }
      : {}),
  }));
  return {
    ok: true,
    fields: [...structuredClone(current.fields), ...copied],
    sections: [
      ...structuredClone(current.sections),
      ...structuredClone(sections).map((section) => ({
        ...section,
        key: sectionsMap.get(section.key)!,
      })),
    ],
  };
}
