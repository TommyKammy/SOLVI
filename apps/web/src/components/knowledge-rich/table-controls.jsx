'use client';
import { useState } from 'react';
import { useEditorState } from '@tiptap/react';
import { ActionButton } from './icon';
import { editTable, insertArticleTable, selectedCell } from './article-table';

const axes = [
  { axis: 'row', label: '行', actions: ['上に行を追加', '下に行を追加', '行を削除'] },
  { axis: 'column', label: '列', actions: ['左に列を追加', '右に列を追加', '列を削除'] },
];
const operations = ['before', 'after', 'delete'];

export function InsertTableButton({ editor }) {
  const enabled = useEditorState({
    editor,
    selector: () => editor.state.selection.empty && editor.can().command(insertArticleTable),
  });
  return (
    <ActionButton
      label="表を挿入"
      icon="table"
      disabled={!enabled}
      onClick={() => {
        if (!editor.view.composing && editor.commands.command(insertArticleTable))
          editor.view.focus();
      }}
    />
  );
}

export function TableControls({ editor }) {
  const cell = useEditorState({
    editor,
    selector: ({ editor }) => {
      const selected = selectedCell(editor.state.selection);
      if (!selected) return null;
      const { table, rowIndex, columnIndex } = selected;
      return {
        row: rowIndex + 1,
        column: columnIndex + 1,
        height: table.childCount,
        width: table.firstChild.childCount,
      };
    },
  });
  const [tabStop, setTabStop] = useState(0);
  if (!cell) return null;
  const nativeFocusGroup = 'focusGroup' in HTMLElement.prototype;
  function navigate(event) {
    if (nativeFocusGroup) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
    const i = buttons.indexOf(event.target);
    const next = {
      Home: 0,
      End: buttons.length - 1,
      ArrowLeft: (i + buttons.length - 1) % buttons.length,
      ArrowRight: (i + 1) % buttons.length,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[next].focus();
  }
  return (
    <div className="table-controls">
      <span id="active-cell">
        選択中のセル　{cell.row}行 {cell.column}列
      </span>
      <div
        role="toolbar"
        aria-label="表の編集"
        aria-describedby="active-cell"
        focusgroup="toolbar wrap"
        onKeyDown={navigate}
      >
        {axes.map(({ axis, label, actions }, group) => (
          <div role="group" aria-label={label} key={axis}>
            {actions.map((name, i) => {
              const index = group * actions.length + i;
              const action = operations[i];
              const disabled =
                action === 'delete' && (axis === 'row' ? cell.height : cell.width) === 1;
              return (
                <ActionButton
                  icon={axis + '-' + action}
                  label={name}
                  key={action}
                  type="button"
                  aria-disabled={disabled}
                  tabIndex={nativeFocusGroup ? undefined : index === tabStop ? 0 : -1}
                  onFocus={() => setTabStop(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!disabled) editTable(editor, axis, action);
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
