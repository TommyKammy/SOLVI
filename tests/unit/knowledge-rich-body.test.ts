import { describe, expect, it } from 'vitest';
import { readKnowledgeBody } from '@solvi/shared/knowledge-schema';

const text = (value: string) => ({ type: 'text', text: value });
const para = (value: string) => ({ type: 'paragraph', content: [text(value)] });
const doc = (...content: unknown[]) => ({ type: 'doc', content });

describe('versioned knowledge body', () => {
  it('counts paragraph separators, hard breaks and UTF-16 pairs in the search projection', () => {
    const first = { type: 'paragraph', content: [text('前'), { type: 'hardBreak' }, text('後')] };
    expect(readKnowledgeBody(doc(first, para('🧊'))).body).toBe('前\n後\n🧊');
    expect(readKnowledgeBody(doc(para('🧊'.repeat(9999)), para('終'))).body.length).toBe(20000);
    expect(() => readKnowledgeBody(doc(para('🧊'.repeat(9999)), para('終端')))).toThrow();
  });
  it('retains nested lists, links and code whitespace', () => {
    const link = {
      type: 'text',
      text: '手順',
      marks: [{ type: 'link', attrs: { href: 'https://example.test/a' } }],
    };
    const nested = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [link] }] }],
    };
    const list = {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [para('確認'), nested] }],
    };
    const result = readKnowledgeBody(doc(list, { type: 'codeBlock', content: [text('  x\n  y')] }));
    expect(result.body).toBe('確認\n手順\n  x\n  y');
    expect(readKnowledgeBody(result.doc)).toEqual(result);
  });
  it('enforces the JSON size limit on the document that will be saved', () => {
    const linkedDoc = (href: string) =>
      doc({
        type: 'paragraph',
        content: [{ ...text('参照'), marks: [{ type: 'link', attrs: { href } }] }],
      });
    const href = 'https://example.test/';
    const base = readKnowledgeBody(linkedDoc(href)).doc;
    const atLimit = href + 'a'.repeat(160000 - JSON.stringify(base).length);
    const saved = readKnowledgeBody(linkedDoc(atLimit));
    expect(JSON.stringify(saved.doc).length).toBe(160000);
    expect(readKnowledgeBody(saved.doc)).toEqual(saved);

    const overLimit = linkedDoc(atLimit + 'a');
    expect(JSON.stringify(overLimit).length).toBeLessThan(160000);
    expect(() => readKnowledgeBody(overLimit)).toThrow(/容量/);
  });
  it.each([
    { type: 'heading', attrs: { level: 1 } },
    { type: 'paragraph', attrs: { style: 'other' } },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'リンク',
          marks: [{ type: 'link', attrs: { href: 'http://example.test' } }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para('a')] }] },
        { type: 'tableRow', content: [] },
      ],
    },
    para('x\0y'),
    para('x'.repeat(160001)),
  ])('rejects unsupported document data', (block) => {
    expect(() => readKnowledgeBody(doc(block))).toThrow();
  });
});
