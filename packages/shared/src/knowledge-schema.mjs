import { Node, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

export function allowedURL(href) {
  if (typeof href !== 'string' || !/^https:\/\//i.test(href) || /[\s\\]/.test(href)) return false;
  if (Array.from(href).some((ch) => ch.charCodeAt(0) < 32) || !href.isWellFormed()) return false;
  return URL.canParse(href) && new URL(href).protocol === 'https:';
}
function cell(name, tag) {
  return Node.create({
    name,
    content: 'paragraph+',
    isolating: true,
    parseHTML: () => [{ tag }],
    renderHTML: () => (tag === 'th' ? ['th', { scope: 'col' }, 0] : ['td', 0]),
  });
}

const articleTableNodes = [
  Node.create({
    name: 'table',
    priority: 90,
    group: 'block',
    content: 'tableRow+',
    isolating: true,
    parseHTML: () => [{ tag: 'table' }],
    renderHTML: () => ['table', ['tbody', 0]],
  }),
  Node.create({
    name: 'tableRow',
    content: '(tableHeader | tableCell)+',
    parseHTML: () => [{ tag: 'tr' }],
    renderHTML: () => ['tr', 0],
  }),
  cell('tableHeader', 'th'),
  cell('tableCell', 'td'),
];

export const extensions = [
  ...articleTableNodes,
  StarterKit.configure({
    heading: { levels: [2, 3] },
    blockquote: false,
    strike: false,
    underline: false,
    horizontalRule: false,
    trailingNode: false,
    link: {
      autolink: false,
      linkOnPaste: false,
      openOnClick: false,
      isAllowedUri: allowedURL,
      HTMLAttributes: { target: null, rel: null, class: null },
    },
  }),
];
export const schema = getSchema(extensions);
const nodeAttrs = {
  heading: { level: [2, 3] },
  orderedList: { start: [1], type: [null] },
  codeBlock: { language: [null] },
};
const linkAttrs = { href: allowedURL, target: [null], rel: [null], class: [null], title: [null] };
const MAX_DOC_JSON_LENGTH = 160000;

function fields(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw Error('文書に許可されていない項目があります');
}
function attributes(attrs, rules) {
  fields(attrs, Object.keys(rules));
  for (const [key, value] of Object.entries(attrs)) {
    const rule = rules[key];
    if (!(Array.isArray(rule) ? rule.includes(value) : rule(value)))
      throw Error('属性またはリンク先が不正です');
  }
}
export function readKnowledgeBody(doc) {
  if (doc?.type !== 'doc' || JSON.stringify(doc).length > MAX_DOC_JSON_LENGTH)
    throw Error('本文の形式または容量が不正です');
  function check(n, depth) {
    fields(n, ['type', 'text', 'attrs', 'marks', 'content']);
    if (typeof n.type !== 'string' || depth > 32 || !Object.hasOwn(schema.nodes, n.type))
      throw Error('未対応の文書要素です');
    const isText = n.type === 'text';
    if (isText ? typeof n.text !== 'string' || n.content !== undefined : n.text !== undefined)
      throw Error('本文の構造が不正です');
    if (isText && (n.text.includes('\0') || !n.text.isWellFormed()))
      throw Error('本文に保存できない文字があります');
    attributes(n.attrs ?? {}, Object.hasOwn(nodeAttrs, n.type) ? nodeAttrs[n.type] : {});
    if (n.type === 'heading' && ![2, 3].includes(n.attrs?.level))
      throw Error('見出しの階層が不正です');
    if (n.type === 'table') {
      const width = n.content?.[0]?.content?.length;
      if (!width || !n.content.every((row) => row.content?.length === width))
        throw Error('表の各行は同じ列数にしてください');
    }
    if (
      (n.content !== undefined && !Array.isArray(n.content)) ||
      (n.marks !== undefined && !Array.isArray(n.marks))
    )
      throw Error('本文の構造が不正です');
    for (const m of n.marks ?? []) {
      fields(m, ['type', 'attrs']);
      if (
        (n.type !== 'text' && n.type !== 'hardBreak') ||
        typeof m.type !== 'string' ||
        !Object.hasOwn(schema.marks, m.type)
      )
        throw Error('未対応の書式です');
      attributes(m.attrs ?? {}, m.type === 'link' ? linkAttrs : {});
      if (m.type === 'link' && !allowedURL(m.attrs?.href))
        throw Error('HTTPSリンクを指定してください');
    }
    for (const child of n.content ?? []) check(child, depth + 1);
  }
  check(doc, 0);
  const parsed = schema.nodeFromJSON(doc);
  parsed.check();
  const body = parsed.textBetween(0, parsed.content.size, '\n', (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : '',
  );
  if (body.length > 20000) throw Error('本文は20,000文字までです');
  const normalized = parsed.toJSON();
  if (JSON.stringify(normalized).length > MAX_DOC_JSON_LENGTH)
    throw Error('正規化後の本文が容量上限を超えています');
  return { doc: normalized, body };
}

export function validateDoc(input) {
  return readKnowledgeBody(input).doc;
}
