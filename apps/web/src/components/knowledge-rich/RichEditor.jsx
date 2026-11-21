'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Slice } from '@tiptap/pm/model';
import { extensions, schema } from './schema';
import { slashCommands, deferToIME } from './slash-commands';
import { ActionButton } from './icon';
import { SelectionMenu } from './selection-menu';
import { BlockHandles } from './block-handles';
import { InsertTableButton, TableControls } from './table-controls';
import { KnowledgeBody } from '../KnowledgeBody';
import { importHTML } from './html';
import './rich-editor.css';
const para = (text) =>
  text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' };

const template = {
  type: 'doc',
  content: ['対象者', '手順', '完了確認'].flatMap((text) => [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] },
    para(),
  ]),
};

export default function RichEditor({
  initialDoc,
  plain,
  disabled,
  onDocument,
  onSource,
  onComposition,
  allowTemplate,
}) {
  const [source, setSource] = useState(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const composing = useRef(false);
  const sourceField = useRef(null);
  const [initial] = useState(() =>
    schema
      .nodeFromJSON(initialDoc ?? { type: 'doc', content: plain.split(/\r\n?|\n/).map(para) })
      .toJSON(),
  );
  const original = useMemo(() => JSON.stringify(initial), [initial]);
  function report(editor) {
    const json = JSON.stringify(editor.getJSON());
    onDocument(json, json !== original);
  }
  const editor = useEditor({
    extensions: [...extensions, slashCommands],
    content: initial,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        id: 'article-body',
        'aria-label': '内容・手順',
        'aria-required': 'true',
        'aria-multiline': 'true',
        'aria-describedby': 'slash-hint',
      },
      handleDOMEvents: {
        // Leave the native candidate window in charge of its navigation and confirming Enter.
        keydown: deferToIME,
        drop: (_view, event) => {
          event.preventDefault();
          return true;
        },
        paste: (view, event) => {
          event.preventDefault();
          try {
            const html = event.clipboardData.getData('text/html');
            if (html)
              view.dispatch(
                view.state.tr.replaceSelection(
                  Slice.maxOpen(view.state.schema.nodeFromJSON(importHTML(html)).content),
                ),
              );
            else view.dispatch(view.state.tr.insertText(event.clipboardData.getData('text/plain')));
            setError('');
          } catch (e) {
            setError(e.message);
          }
          return true;
        },
      },
    },
    onCreate: ({ editor }) => report(editor),
    onUpdate: ({ editor }) => report(editor),
  });
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  useEffect(() => {
    if (source !== null) sourceField.current?.focus();
  }, [source !== null]);
  function apply() {
    if (composing.current || disabled) return;
    try {
      editor.commands.setContent(importHTML(source), { errorOnInvalidContent: true });
      setSource(null);
      onSource(false);
      setError('');
      editor.commands.focus();
    } catch (err) {
      setError(err.message);
      sourceField.current?.focus();
    }
  }
  if (!editor) return <p className="hint">エディタを読み込んでいます…</p>;
  return (
    <fieldset
      className="knowledge-rich"
      disabled={disabled}
      onCompositionStart={() => {
        composing.current = true;
        onComposition(true);
      }}
      onCompositionEnd={() => {
        composing.current = false;
        onComposition(false);
      }}
    >
      <legend>内容・手順</legend>
      <section hidden={source !== null}>
        <div className="actions">
          {allowTemplate && (
            <ActionButton
              icon="template"
              label="手順テンプレートを使う"
              disabled={!editor.isEmpty}
              onClick={() => editor.chain().focus().setContent(template).run()}
            />
          )}
          <ActionButton
            icon="h2"
            label="見出し2"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          />
          <ActionButton
            icon="ordered"
            label="番号付き手順"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <ActionButton
            icon="bold"
            label="太字"
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          {editor && <InsertTableButton editor={editor} />}
          <ActionButton
            icon="undo"
            label="元に戻す"
            onClick={() => editor.chain().focus().undo().run()}
          />
          <ActionButton
            icon="redo"
            label="やり直す"
            onClick={() => editor.chain().focus().redo().run()}
          />
          <ActionButton
            icon="source"
            label="HTMLソース"
            onClick={() => {
              if (!composing.current) {
                onSource(true);
                setSource(editor.getHTML());
                setError('');
              }
            }}
          />
        </div>
        <p id="slash-hint">段落の先頭で / を入力すると、見出し・手順・表などを選べます。</p>
        <div className="editor-surface">
          {editor && !disabled && source === null && <BlockHandles editor={editor} />}
          <EditorContent editor={editor} />
          {editor && !disabled && source === null && <SelectionMenu editor={editor} />}
        </div>
        {editor && <TableControls editor={editor} />}
        <details onToggle={(event) => setPreview(event.currentTarget.open)}>
          <summary>公開プレビュー</summary>
          {preview && <KnowledgeBody article={{ body: '', bodyDocV1: editor.getJSON() }} />}
        </details>
      </section>
      {source !== null && (
        <section>
          <label htmlFor="source">HTMLソース</label>
          <textarea
            ref={sourceField}
            id="source"
            value={source}
            aria-describedby={error ? 'error' : undefined}
            onChange={(e) => {
              setSource(e.target.value);
              setError('');
            }}
          />
          <div className="actions">
            <ActionButton icon="apply" label="適用" showLabel onClick={apply} />
            <ActionButton
              icon="cancel"
              label="取消"
              showLabel
              onClick={() => {
                if (!composing.current) {
                  onSource(false);
                  setSource(null);
                  setError('');
                }
              }}
            />
          </div>
        </section>
      )}

      {error && (
        <p id="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
