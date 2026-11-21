import { createElement, type ReactNode } from 'react';
import type { JSONContent } from '@solvi/shared/knowledge-schema';
import { TableRegion } from './TableRegion';
import './knowledge-rich/knowledge-body.css';

const tags: Record<string, string> = {
  paragraph: 'p',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  tableRow: 'tr',
  tableCell: 'td',
  tableHeader: 'th',
};
function render(node: JSONContent, key: number): ReactNode {
  const children = node.content?.map(render);
  switch (node.type) {
    case 'doc':
      return children;
    case 'table': {
      const label = `記事本文の表（ブロック ${key + 1}）`;
      return (
        <TableRegion key={key} label={label}>
          <table>
            <caption className="visually-hidden">{label}</caption>
            <tbody>{children}</tbody>
          </table>
        </TableRegion>
      );
    }
    case 'heading':
      return createElement(node.attrs?.level === 3 ? 'h3' : 'h2', { key }, children);
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{children}</code>
        </pre>
      );
    case 'hardBreak':
    case 'text': {
      let text: ReactNode = node.type === 'hardBreak' ? <br key={key} /> : node.text;
      for (const mark of [...(node.marks ?? [])].reverse()) {
        if (mark.type === 'link' && /^https:\/\//i.test(mark.attrs?.href))
          text = (
            <a key={key} href={mark.attrs?.href}>
              {text}
            </a>
          );
        else if (mark.type === 'bold') text = <strong key={key}>{text}</strong>;
        else if (mark.type === 'italic') text = <em key={key}>{text}</em>;
        else if (mark.type === 'code') text = <code key={key}>{text}</code>;
      }
      return text;
    }
    default:
      if (!node.type || !Object.hasOwn(tags, node.type)) return null;
      return createElement(
        tags[node.type]!,
        { key, scope: node.type === 'tableHeader' ? 'col' : undefined },
        children,
      );
  }
}
export function KnowledgeBody({
  article,
}: {
  article: { body: string; bodyDocV1?: JSONContent | null };
}) {
  return article.bodyDocV1 ? (
    <div className="knowledge-rich-content">{render(article.bodyDocV1, 0)}</div>
  ) : (
    <p className="knowledge-prose">{article.body}</p>
  );
}
