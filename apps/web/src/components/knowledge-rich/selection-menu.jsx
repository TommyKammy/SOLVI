'use client';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEditorState } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { ActionButton } from './icon';

const marks = [
  ['bold', '太字'],
  ['italic', '斜体'],
  ['code', 'インラインコード'],
];
const options = { placement: 'top', offset: 8, flip: true, shift: { padding: 8 } };
function show({ editor, view, state, element, from, to }) {
  return (
    editor.isEditable &&
    !view.composing &&
    state.selection instanceof TextSelection &&
    !!state.doc.textBetween(from, to) &&
    !state.selection.$from.parent.type.spec.code &&
    (view.hasFocus() || element.contains(document.activeElement))
  );
}
export function SelectionMenu({ editor }) {
  const active = useEditorState({
    editor,
    selector: () => marks.map(([mark]) => editor.isActive(mark)),
  });
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionFormat"
      shouldShow={show}
      updateDelay={0}
      options={options}
      className="knowledge-selection-menu"
    >
      <div role="group" aria-label="選択範囲の書式" className="selection-actions">
        {marks.map(([mark, label], i) => (
          <ActionButton
            key={mark}
            label={'選択範囲を' + label}
            icon={mark}
            aria-pressed={active[i]}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!editor.view.composing) {
                editor.commands.toggleMark(mark);
                editor.view.focus();
              }
            }}
          />
        ))}
      </div>
    </BubbleMenu>
  );
}
