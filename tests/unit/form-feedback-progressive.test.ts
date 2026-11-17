// NFR-UX-002, NFR-UX-004: server-rendered forms must stay usable before hydration.
// Real browser focus and no-JS submission are checked by tools/check_accessibility.mjs.
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/web/src/components/ContextLink', () => ({
  ReturnToField: () => null,
}));

import { FeedbackForm } from '../../apps/web/src/components/FeedbackForm';

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const form = (pending: boolean) =>
  renderToStaticMarkup(
    createElement(
      FeedbackForm,
      {
        action: '#',
        feedback: { message: '' },
        pending,
        className: 'stack',
      },
      createElement('button', { type: 'submit' }, '保存する'),
    ),
  );

describe('FeedbackForm keeps the server-rendered form operable', () => {
  it('does not render inert before hydration', () => {
    const html = form(false);
    expect(html).not.toContain('inert');
    expect(html).toContain('aria-busy="false"');
  });

  it('keeps its controls in the initial HTML', () => {
    const html = form(false);
    expect(html).toContain('<form');
    expect(html).toContain('action="#"');
    expect(html).toContain('保存する');
  });

  it('marks only an in-flight submission as busy', () => {
    expect(form(true)).toContain('aria-busy="true"');
    expect(form(true)).not.toContain('入力画面を準備しています');
  });
});
