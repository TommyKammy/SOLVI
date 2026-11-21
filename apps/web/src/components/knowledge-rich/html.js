/* global document */
import { parseFragment } from 'parse5';
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import { schema, allowedURL, validateDoc } from './schema';

const tags = new Set(
  'p br h2 h3 strong b em i ol ul li pre code a table tbody tr th td'.split(' '),
);
const alias = { b: 'strong', i: 'em' };
export function serialize(doc) {
  const host = document.createElement('div');
  host.append(DOMSerializer.fromSchema(schema).serializeFragment(schema.nodeFromJSON(doc).content));
  return host.innerHTML;
}

// Build detached nodes from allowlisted parser tokens. Check consumed source spans
// so that parser repairs cannot silently remove markup from the author's input.
function readSource(source) {
  if (source.length > 160000) throw Error('ソースの容量を超えています');
  const root = parseFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError(e) {
      throw Error(e.startLine + '行' + e.startCol + '列：HTMLの構文が不正です');
    },
  });
  const container = document.createElement('div');
  function append(parent, children, start, end, depth) {
    let offset = start;
    for (const child of children) {
      const loc = child.sourceCodeLocation;
      const fail = (msg) => {
        throw Error((loc?.startLine ?? 1) + '行' + (loc?.startCol ?? 1) + '列：' + msg);
      };
      // HTML permits rows directly inside a table. Verify every source byte of the
      // implied tbody against the original row tokens just as for explicit markup.
      if (!loc && child.tagName === 'tbody' && parent.localName === 'table') {
        const last = child.childNodes.at(-1)?.sourceCodeLocation;
        if (!last) fail('表の行境界が不正です');
        const body = document.createElement('tbody');
        append(body, child.childNodes, offset, last.endOffset, depth + 1);
        parent.append(body);
        offset = last.endOffset;
        continue;
      }
      if (!loc || loc.startOffset !== offset || depth > 32)
        fail('HTMLの入れ子または要素境界が不正です');
      offset = loc.endOffset;
      if (child.nodeName === '#text') {
        parent.append(child.value);
        continue;
      }
      if (!tags.has(child.tagName)) fail('未対応の要素 ' + child.nodeName);
      const el = document.createElement(alias[child.tagName] ?? child.tagName);
      for (const attr of child.attrs) {
        if (child.tagName === 'th' && attr.name === 'scope' && attr.value === 'col') continue;
        if (child.tagName !== 'a' || attr.name !== 'href') fail('未対応の属性 ' + attr.name);
        if (!allowedURL(attr.value)) fail('絶対HTTPSリンクを指定してください');
        el.setAttribute('href', attr.value);
      }
      if (child.tagName === 'th') el.setAttribute('scope', 'col');
      if (child.tagName === 'a' && !el.hasAttribute('href')) fail('リンク先が必要です');
      if (child.tagName !== 'br') {
        if (!loc.endTag) fail('終了タグが必要です');
        append(el, child.childNodes, loc.startTag.endOffset, loc.endTag.startOffset, depth + 1);
      }
      parent.append(el);
    }
    if (offset !== end) throw Error('文字位置 ' + (offset + 1) + '：HTMLが暗黙に補正されました');
  }
  append(container, root.childNodes, 0, source.length, 0);
  return container;
}
export function importHTML(source) {
  const dom = readSource(source);
  // Formatting whitespace between blocks has no article meaning.
  for (const parent of [
    dom,
    ...dom.querySelectorAll('ol,ul,li,table,tbody,tr,td:has(> p),th:has(> p)'),
  ]) {
    for (const n of [...parent.childNodes])
      if (n.nodeType === 3 && !n.textContent.trim()) n.remove();
  }
  // Bare inline cell contents and empty cells have one editable paragraph.
  for (const cell of dom.querySelectorAll('th,td')) {
    if (![...cell.children].every((el) => ['A', 'BR', 'CODE', 'EM', 'STRONG'].includes(el.tagName)))
      continue;
    const paragraph = document.createElement('p');
    paragraph.append(...cell.childNodes);
    cell.append(paragraph);
  }
  const doc = validateDoc(
    DOMParser.fromSchema(schema).parse(dom, { preserveWhitespace: true }).toJSON(),
  );
  if (serialize(doc) !== dom.innerHTML)
    throw Error(
      '本文構造または書式が変わるため適用できません。段落・リストの入れ子を確認してください',
    );
  return doc;
}
