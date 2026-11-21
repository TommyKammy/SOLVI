import { extensions } from '@solvi/shared/knowledge-schema';
import { Fragment } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Plugin, TextSelection } from '@tiptap/pm/state';

const table = extensions.find((extension) => extension.name === 'table');
export const editableTable = table.extend({
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            click(view, event) {
              const target = event.target.closest?.('td,th');
              if (
                !target ||
                !view.editable ||
                event.button !== 0 ||
                event.shiftKey ||
                event.metaKey ||
                event.ctrlKey ||
                !view.dom.ownerDocument.getSelection()?.isCollapsed
              )
                return false;
              // WebKit sometimes leaves a gap cursor outside a table after a click
              // in the unoccupied part of a cell. Resolve that hit against the cell itself.
              const inside = view.posAtDOM(target, 0);
              if (selectedCell(view.state.selection)?.cellPos === inside - 1) return false;
              const start = view.state.doc.resolve(inside);
              const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
              const pos = hit >= inside && hit < start.end() ? hit : inside;
              view.dispatch(
                view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))),
              );
              view.focus();
              return true;
            },
          },
          decorations(state) {
            const selected = selectedCell(state.selection);
            if (!selected) return null;
            const { cellPos, cell } = selected;
            return DecorationSet.create(state.doc, [
              Decoration.node(cellPos, cellPos + cell.nodeSize, { class: 'active-table-cell' }),
            ]);
          },
        },
      }),
    ];
  },
});

export function insertArticleTable({ tr, dispatch }) {
  const { $from } = tr.selection;
  if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return false;
  if (!dispatch) return true;

  const { nodes } = tr.doc.type.schema;
  const makeHeader = (label) =>
    nodes.tableHeader.create(null, nodes.paragraph.create(null, tr.doc.type.schema.text(label)));
  const makeBodyRow = () =>
    nodes.tableRow.create(null, [nodes.tableCell.createAndFill(), nodes.tableCell.createAndFill()]);
  const table = nodes.table.create(null, [
    nodes.tableRow.create(null, [makeHeader('列1'), makeHeader('列2')]),
    makeBodyRow(),
    makeBodyRow(),
  ]);

  // Keep the original paragraph (and any suffix after the slash query) below the table.
  const start = $from.before();
  tr.insert(start, table);
  const first = TextSelection.near(tr.doc.resolve(start + 1));
  tr.setSelection(TextSelection.create(tr.doc, first.from, first.$from.end()));
  return true;
}

export function selectedCell(selection) {
  if (!(selection instanceof TextSelection)) return null;
  const { $from, to } = selection;
  for (let depth = $from.depth; depth >= 3; depth--) {
    const cell = $from.node(depth);
    if (!['tableCell', 'tableHeader'].includes(cell.type.name)) continue;
    if (to > $from.end(depth)) return null;
    return {
      table: $from.node(depth - 2),
      tablePos: $from.before(depth - 2),
      rowIndex: $from.index(depth - 2),
      columnIndex: $from.index(depth - 1),
      cell,
      cellPos: $from.before(depth),
    };
  }
  return null;
}

// Only the selected table changes. Reuse the surviving ProseMirror nodes so
// paragraphs, inline marks and header types stay intact on every edit.
export function editTable(editor, axis, action) {
  const { tr } = editor.state;
  const selected = selectedCell(tr.selection);
  if (!selected || !editor.isEditable || editor.view.composing) return false;
  const { table, tablePos, rowIndex, columnIndex } = selected;
  const isRow = axis === 'row';
  const deleting = action === 'delete';
  const rows = [...table.children];
  const width = rows[0].childCount;
  const size = isRow ? rows.length : width;
  if (deleting && size === 1) return false;

  const { nodes } = tr.doc.type.schema;
  const at = (isRow ? rowIndex : columnIndex) + (action === 'after' ? 1 : 0);
  function emptyCell(type) {
    return type === nodes.tableHeader
      ? type.create(null, nodes.paragraph.create(null, tr.doc.type.schema.text('見出し')))
      : type.createAndFill();
  }
  if (isRow) {
    if (deleting) rows.splice(at, 1);
    else {
      const beforeHeader =
        action === 'before' &&
        rows[rowIndex].children.every((cell) => cell.type === nodes.tableHeader);
      const type = beforeHeader ? nodes.tableHeader : nodes.tableCell;
      rows.splice(
        at,
        0,
        nodes.tableRow.create(
          null,
          Array.from({ length: width }, () => emptyCell(type)),
        ),
      );
    }
  } else {
    rows.forEach((row, i) => {
      const cells = [...row.children];
      if (deleting) cells.splice(at, 1);
      else cells.splice(at, 0, emptyCell(row.child(columnIndex).type));
      rows[i] = row.copy(Fragment.fromArray(cells));
    });
  }
  const next = table.copy(Fragment.fromArray(rows));
  closeHistory(tr).replaceWith(tablePos, tablePos + table.nodeSize, next);
  const row = isRow ? Math.min(at, rows.length - 1) : rowIndex;
  const col = isRow ? columnIndex : Math.min(at, rows[row].childCount - 1);
  const rowStart = tr.doc.resolve(tablePos + 1).posAtIndex(row);
  const cellStart = tr.doc.resolve(rowStart + 1).posAtIndex(col);
  const caret = TextSelection.near(tr.doc.resolve(cellStart + 1));
  const replaceLabel = !deleting && rows[row].child(col).type === nodes.tableHeader;
  tr.setSelection(
    replaceLabel ? TextSelection.create(tr.doc, caret.from, caret.$from.end()) : caret,
  );
  editor.view.dispatch(tr);
  // Subsequent typing must have its own undo step, even in the newly inserted cell.
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.view.focus();
  return true;
}
