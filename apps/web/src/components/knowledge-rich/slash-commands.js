/* global document */
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';

import { insertArticleTable } from './article-table';

const key = new PluginKey('articleSlash');
const commands = [
  {
    label: '見出し2',
    icon: 'h2',
    keywords: 'h2 みだし2',
    apply: (chain) => chain.setHeading({ level: 2 }),
  },
  {
    label: '見出し3',
    icon: 'h3',
    keywords: 'h3 みだし3',
    apply: (chain) => chain.setHeading({ level: 3 }),
  },
  {
    label: '番号付き手順',
    icon: 'ordered',
    keywords: 'てじゅん 番号 ordered',
    apply: (chain) => chain.toggleOrderedList(),
  },
  {
    label: '箇条書き',
    icon: 'bullet',
    keywords: 'かじょうがき bullet',
    apply: (chain) => chain.toggleBulletList(),
  },
  {
    label: 'コードブロック',
    icon: 'codeblock',
    keywords: 'こーど code',
    apply: (chain) => chain.setCodeBlock(),
  },
  {
    label: '表',
    icon: 'table',
    keywords: 'ひょう table',
    topLevel: true,
    apply: (chain) => chain.command(insertArticleTable),
  },
];

export function deferToIME(view, event) {
  return (
    key.getState(view.state)?.active &&
    (view.composing || event.isComposing || event.keyCode === 229) &&
    ['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)
  );
}

function renderMenu() {
  let latest,
    list,
    unmount,
    selected = 0;
  function select(index) {
    selected = index;
    const input = latest.editor.view.dom;
    for (const [i, option] of Array.from(list.children).entries()) {
      option.setAttribute('aria-selected', String(i === selected));
    }
    const active = list.children[selected];
    if (active) input.setAttribute('aria-activedescendant', active.id);
    else input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    if (!latest?.items[index] || latest.editor.view.composing) return;
    latest.command(latest.items[index]);
  }
  function update(props) {
    const queryChanged = latest?.query !== props.query;
    latest = props;
    list.replaceChildren();
    for (const [i, item] of props.items.entries()) {
      const option = document.createElement('div');
      option.setAttribute('role', 'option');
      option.id = list.id + '-' + i;
      const ns = 'http://www.w3.org/2000/svg';
      const icon = document.createElementNS(ns, 'svg');
      icon.setAttribute('class', 'editor-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('viewBox', '0 0 24 24');
      const glyph = document.createElementNS(ns, 'use');
      glyph.setAttribute('href', '/editor-icons.svg#' + item.icon);
      icon.append(glyph);
      option.append(icon, item.label);
      option.onpointerdown = (event) => event.preventDefault(); // Keep the editing selection.
      option.onclick = () => choose(i);
      list.append(option);
    }
    if (!props.items.length) {
      const empty = document.createElement('div');
      empty.setAttribute('role', 'option');
      empty.setAttribute('aria-disabled', 'true');
      empty.textContent = props.loading ? '候補を表示中' : '候補がありません';
      list.append(empty);
    }
    select(
      props.items.length
        ? queryChanged
          ? 0
          : Math.max(0, Math.min(selected, props.items.length - 1))
        : -1,
    );
  }
  return {
    onStart(props) {
      list = document.createElement('div');
      list.id = 'slash-' + crypto.randomUUID();
      list.className = 'knowledge-slash-menu';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', '記事のコマンド');
      props.editor.view.dom.setAttribute('aria-controls', list.id);
      update(props);
      unmount = props.mount(list);
    },
    onUpdate: update,
    onKeyDown({ event, view }) {
      if (deferToIME(view, event) || !latest?.items.length) return false;
      if (event.key === 'Enter') {
        choose(selected);
        return true;
      }
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return false;
      const count = latest.items.length;
      select((selected + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
      return true;
    },
    onExit() {
      const input = latest?.editor.view.dom;
      input?.removeAttribute('aria-controls');
      input?.removeAttribute('aria-activedescendant');
      unmount?.();
      latest = undefined;
      selected = 0;
    },
  };
}

export const slashCommands = Extension.create({
  name: 'articleSlashCommands',
  priority: 1100,
  onBlur() {
    if (key.getState(this.editor.state)?.active) exitSuggestion(this.editor.view, key);
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: key,
        char: '/',
        container: 'main',
        startOfLine: true,
        allow: ({ editor, state, range }) => {
          const start = state.doc.resolve(range.from);
          const marks = state.storedMarks ?? state.selection.$from.marks();
          return (
            editor.isFocused &&
            start.parent.type.name === 'paragraph' &&
            start.parentOffset === 0 &&
            !['tableHeader', 'tableCell'].includes(start.node(-1).type.name) &&
            !marks.some((mark) => mark.type.name === 'code' || mark.type.name === 'link') &&
            !state.doc.rangeHasMark(range.from, range.to, state.schema.marks.code) &&
            !state.doc.rangeHasMark(range.from, range.to, state.schema.marks.link)
          );
        },
        items: ({ query, editor }) =>
          commands.filter(
            (item) =>
              (!item.topLevel || editor.state.selection.$from.depth === 1) &&
              (item.label + ' ' + item.keywords).includes(query.toLowerCase()),
          ),
        command: ({ editor, range, props: item }) => {
          if (!editor.view.hasFocus() || editor.view.composing) return;
          if (item.apply(editor.can().chain().deleteRange(range)).run())
            item.apply(editor.chain().deleteRange(range)).run();
        },
        render: renderMenu,
      }),
    ];
  },
});
