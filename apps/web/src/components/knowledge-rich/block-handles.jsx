'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { closeHistory } from '@tiptap/pm/history';
import { Selection } from '@tiptap/pm/state';
import { ActionButton, Icon } from './icon';

function blockLabel(node) {
  switch (node?.type.name) {
    case 'paragraph':
      return '段落';
    case 'heading':
      return '見出し' + node.attrs.level;
    case 'bulletList':
      return '箇条書き';
    case 'orderedList':
      return '番号付き手順';
    case 'codeBlock':
      return 'コードブロック';
    case 'table':
      return '表';
    default:
      return null;
  }
}

// Measure actual top-level node views. View-only widgets are not document blocks.
function layout(editor) {
  const origin = editor.view.dom.getBoundingClientRect().top;
  const blocks = [];
  editor.state.doc.forEach((node, pos, index) => {
    const rect = editor.view.nodeDOM(pos).getBoundingClientRect();
    blocks.push({ index, label: blockLabel(node), top: rect.top - origin, height: rect.height });
  });
  return blocks;
}

export function BlockHandles({ editor }) {
  const [blocks, setBlocks] = useState([]);
  const [line, setLine] = useState(null);
  const [open, setOpen] = useState(null);
  const [message, setMessage] = useState('');
  const panel = useRef(null);
  const gesture = useRef(null);
  const ignoreClick = useRef(false);
  function cancel() {
    gesture.current = null;
    setLine(null);
    setOpen(null);
  }
  useLayoutEffect(() => {
    function measure() {
      setBlocks(layout(editor));
    }
    function changed() {
      cancel();
      measure();
    }
    function outside(e) {
      if (!panel.current?.contains(e.target)) setOpen(null);
    }
    function escape(e) {
      if (e.key === 'Escape') cancel();
    }
    const observer = new ResizeObserver(measure);
    observer.observe(editor.view.dom);
    editor.on('update', changed);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    measure();
    return () => {
      observer.disconnect();
      editor.off('update', changed);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [editor]);

  function move(index, boundary) {
    const { doc, tr } = editor.state;
    const block = doc.maybeChild(index);
    const label = blockLabel(block);
    if (
      !editor.isEditable ||
      editor.view.composing ||
      !label ||
      boundary < 0 ||
      boundary > doc.childCount ||
      boundary === index ||
      boundary === index + 1
    )
      return;
    const root = doc.resolve(0);
    const from = root.posAtIndex(index);
    const target = root.posAtIndex(boundary);
    closeHistory(tr).delete(from, from + block.nodeSize);
    const destination = tr.mapping.map(target);
    tr.insert(destination, block);
    tr.setSelection(Selection.near(tr.doc.resolve(destination + 1)));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.view.focus();
    setMessage(label + 'を' + (boundary > index ? boundary : boundary + 1) + '番目に移動しました');
  }
  function dragStart(e, index) {
    if (!e.isPrimary || e.button !== 0 || editor.view.composing) return;
    ignoreClick.current = false;
    gesture.current = { id: e.pointerId, index, doc: editor.state.doc, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function dropSpot(e) {
    const rect = editor.view.dom.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    )
      return null;
    const y = e.clientY - rect.top;
    const next = blocks.find((block) => y < block.top + block.height / 2);
    return next
      ? { index: next.index, top: next.top }
      : { index: blocks.length, top: blocks.at(-1).top + blocks.at(-1).height };
  }
  function dragMove(e) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4 && !g.dragging) return;
    g.dragging = true;
    ignoreClick.current = true;
    setOpen(null);
    setLine(dropSpot(e)?.top ?? null);
  }
  function dragEnd(e) {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    setLine(null);
    const spot = dropSpot(e);
    if (g.dragging && spot && g.doc === editor.state.doc) move(g.index, spot.index);
  }
  return (
    <div className="block-tools" ref={panel}>
      {blocks.length > 1 &&
        blocks
          .filter((b) => b.label)
          .map(({ index, top, label }) => (
            <div className="block-handle" key={index} style={{ top }}>
              <button
                type="button"
                className="grip"
                title={label + 'を移動'}
                aria-label={`${index + 1}番目のブロックの${label}を移動`}
                aria-expanded={open === index}
                onPointerDown={(e) => dragStart(e, index)}
                onPointerMove={dragMove}
                onPointerUp={dragEnd}
                onPointerCancel={cancel}
                onLostPointerCapture={() => {
                  gesture.current = null;
                  setLine(null);
                }}
                onClick={(e) => {
                  if (e.detail === 0 || !ignoreClick.current)
                    setOpen(open === index ? null : index);
                  ignoreClick.current = false;
                }}
              >
                <Icon name="grip" />
              </button>
              {open === index && (
                <div className="move-actions" role="group" aria-label={label + 'の移動先'}>
                  <ActionButton
                    icon="up"
                    label={label + 'を上へ移動'}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  />
                  <ActionButton
                    icon="down"
                    label={label + 'を下へ移動'}
                    disabled={index === blocks.length - 1}
                    onClick={() => move(index, index + 2)}
                  />
                </div>
              )}
            </div>
          ))}
      {line !== null && <div className="drop-line" style={{ top: line }} aria-hidden="true" />}
      <span className="visually-hidden" aria-live="polite">
        {message}
      </span>
    </div>
  );
}
