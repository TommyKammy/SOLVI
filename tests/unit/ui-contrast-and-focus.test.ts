// NFR-UX-002: control boundaries, keyboard focus and both UI v2 themes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'apps/web/src/app/freshservice.css'), 'utf8');
const layout = readFileSync(join(process.cwd(), 'apps/web/src/app/layout.tsx'), 'utf8');
const themeToggle = readFileSync(
  join(process.cwd(), 'apps/web/src/components/ThemeToggle.tsx'),
  'utf8',
);

type Theme = 'light' | 'dark';

/** 11.3 §4 のトークンは light-dark(ライト, ダーク) で1か所に定義する。 */
const token = (name: string): Record<Theme, string> => {
  const match = css.match(
    new RegExp(`--${name}:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{6})\\s*,\\s*(#[0-9a-fA-F]{6})\\s*\\)`),
  );
  expect(match, `--${name} is missing a light-dark() pair`).toBeTruthy();
  return { light: match![1]!, dark: match![2]! };
};

const singleToken = (name: string): string => {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  expect(value, `--${name} is missing`).toBeTruthy();
  return value!;
};

const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
};

const contrast = (a: string, b: string): number => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
};

const design = readFileSync(
  join(process.cwd(), 'docs/planning/11_UI_UX/11.3_Design_System.md'),
  'utf8',
);
const expected = Array.from(
  design.matchAll(/^\| `--([\w-]+)` \| (#[\da-f]{6}) \| (#[\da-f]{6}) \|/gim),
);
describe('UI v2 design tokens', () => {
  it('defines every 11.3 §4 token for both themes with the documented value', () => {
    expect(expected).toHaveLength(18);
    for (const [, name, light, dark] of expected) {
      expect(token(name!), `--${name}`).toEqual({
        light: light!.toLowerCase(),
        dark: dark!.toLowerCase(),
      });
    }
  });

  it('defines light and dark through color-scheme, including an OS fallback', () => {
    expect(css).toMatch(/:root\s*{[^}]*color-scheme:\s*light/);
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*{[^}]*:root:not\(\[data-theme='light'\]\)\s*{[^}]*color-scheme:\s*dark/,
    );
  });

  it.each<Theme>(['light', 'dark'])('meets 4.5:1 for text on its surface (%s)', (theme) => {
    const pairs: Array<[string, string, string]> = [
      ['ink', 'surface', '本文'],
      ['muted', 'surface', '補足文字'],
      ['ink', 'panel', 'カード本文'],
      ['muted', 'panel', 'カード補足'],
      ['ink', 'side-current', 'ポータル見出しの背景グラデーションの終端'],
      ['side-ink', 'side', 'サイドバー文字'],
      ['side-muted', 'side', 'サイドバー補足'],
      ['side-ink', 'side-hover', 'サイドバーのホバー'],
      ['side-ink', 'side-current', 'サイドバーの現在地'],
      ['side-brand', 'side', 'サイドバーの強調'],
      ['side-brand', 'side-current', 'サイドバーの選択行'],
      ['btn-ink', 'btn', '主ボタン'],
      ['danger', 'surface', '期限超過'],
      ['warn', 'surface', '期限間近'],
      ['ok', 'surface', '正常'],
    ];
    for (const [foreground, background, label] of pairs) {
      const result = contrast(token(foreground)[theme], token(background)[theme]);
      expect(result, `${theme}: ${label} (${foreground}/${background})`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it.each<Theme>('keeps sidebar count text at 4.5:1 in every row state (%s)', (theme) => {
    const combinations: Array<[string, string, string]> = [
      ['side-muted', 'side', '通常行'],
      ['side-brand', 'side', '通常行の強調'],
      ['danger', 'side', '通常行の期限超過'],
      ['side-ink', 'side', 'フォーカス行'],
      ['side-ink', 'side-hover', 'ホバー行'],
      ['side-ink', 'side-current', '現在地'],
    ];
    for (const [foreground, background, label] of combinations) {
      const result = contrast(token(foreground)[theme], token(background)[theme]);
      expect(
        result,
        `${theme}: サイドバー件数 ${label} (${foreground}/${background})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('switches count text to side-ink on hover, focus and the current row', () => {
    expect(css).toMatch(/\.fs-side-count\s*{[^}]*color:\s*var\(--side-muted\)/);
    expect(css).toMatch(
      /\.fs-side-count\[data-tone='brand'\]\s*{[^}]*color:\s*var\(--side-brand\)/,
    );
    expect(css).toMatch(/\.fs-side-count\[data-tone='danger'\]\s*{[^}]*color:\s*var\(--danger\)/);
    const states =
      css.match(
        /body\.fs-ui \.fs-side-link:hover \.fs-side-count,[^}]*{[^}]*color:\s*var\(--side-ink\)/,
      )?.[0] ?? '';
    expect(states).toContain('body.fs-ui .fs-side-link:focus-visible .fs-side-count');
    expect(states).toContain("body.fs-ui .fs-side-link[aria-current='page'] .fs-side-count");
  });

  it.each<Theme>(['light', 'dark'])(
    'keeps control borders at 3:1 against the surface (WCAG 1.4.11, %s)',
    (theme) => {
      expect(
        contrast(singleToken('fs-control-border'), token('surface')[theme]),
      ).toBeGreaterThanOrEqual(3);
    },
  );

  it.each<Theme>(['light', 'dark'])(
    'keeps text on brand- and button-filled controls at 4.5:1 (WCAG 1.4.3, %s)',
    (theme) => {
      expect(contrast(token('btn-ink')[theme], token('btn')[theme])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token('surface')[theme], token('side-brand')[theme])).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );

  it('does not pair a brand-filled background with fixed white text', () => {
    const brandFilled =
      css.match(/{[^}]*background:\s*var\(--fs-brand(?:-strong)?\);[^}]*}/g) ?? [];
    expect(brandFilled.length).toBeGreaterThan(0);
    for (const rule of brandFilled) expect(rule).not.toMatch(/color:\s*#fff/i);
    expect(css).toMatch(
      /\.directory-cta\s*{[^}]*background:\s*var\(--btn\);[^}]*color:\s*var\(--btn-ink\)/,
    );
  });

  it('uses the adopted 14rem sidebar and an accessible selected row', () => {
    expect(css).toMatch(/--fs-rail-width:\s*14rem/);
    expect(css).toMatch(/\.fs-rail\s*{[^}]*inline-size:\s*var\(--fs-rail-width\)/);
    expect(css).toMatch(/\.fs-rail\s*{[^}]*background:\s*var\(--side\)/);
    expect(css).toMatch(/\.fs-rail\s*{[^}]*border-inline-end:\s*1px solid var\(--side-line\)/);
    expect(css).toMatch(
      /body\.fs-ui \.fs-side-link\[aria-current='page'\]\s*{[^}]*background:\s*var\(--side-current\)[^}]*color:\s*var\(--side-brand\)/,
    );
    expect(css).not.toMatch(/\.fs-rail\s*{[^}]*width:\s*64px/);
    expect(css).not.toContain('.fs-flyout');
  });

  it('uses the adopted 4rem toolbar and radius scale', () => {
    expect(css).toMatch(/--fs-toolbar-height:\s*4rem/);
    expect(css).toMatch(/\.fs-topbar\s*{[^}]*min-block-size:\s*var\(--fs-toolbar-height\)/);
    expect(css).toMatch(/--fs-radius-sm:\s*8px/);
    expect(css).toMatch(/--fs-radius-md:\s*12px/);
    expect(css).toMatch(/--fs-radius-toggle:\s*8px/);
    expect(css).toMatch(/--fs-shadow-sm:\s*none/);
    expect(css).toMatch(/--fs-shadow-md:\s*none/);
  });
});

describe('freshservice control affordances', () => {
  it('shows a keyboard focus ring around the portal search', () => {
    expect(css).toContain('.support-search:focus-within');
    expect(css).toMatch(/\.support-search:focus-within\s*{[^}]*outline:/);
  });

  it('removes the closed mobile sidebar from the tab order and the accessibility tree', () => {
    const mobile =
      css.match(/@media \(max-width: 63rem\)\s*{\s*\/\* 初期状態([\s\S]*?)\n}/)?.[1] ?? '';
    expect(mobile).toMatch(/\.fs-rail\s*{[^}]*visibility:\s*hidden/);
    expect(mobile).toMatch(/\.fs-app--nav-open \.fs-rail\s*{[^}]*visibility:\s*visible/);
    // Descendants must not force `visible`: it would override the hidden sidebar
    // and keep its links focusable (found in the 2026-11-17 browser check).
    const visibilityRules = [...mobile.matchAll(/([^{}]*){([^}]*visibility:\s*visible[^}]*)}/g)];
    expect(visibilityRules.length).toBeGreaterThan(0);
    for (const [, selector] of visibilityRules) {
      expect(selector).toContain('.fs-app--nav-open .fs-rail');
    }
  });

  it('uses at least 1rem input text on touch devices to prevent iOS focus zoom', () => {
    const inputs = css.match(/body\.fs-ui input\[type='text'\],[\s\S]*?\n}/)?.[0] ?? '';
    expect(inputs).toContain('font-size: var(--fs-input-font)');
    expect(css).toMatch(
      /@media \(any-pointer: coarse\)\s*{\s*:root\s*{[^}]*--fs-input-font:\s*max\(1rem, 1em\)/,
    );
  });

  it('expands touch targets and keeps focus visible in forced colors', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*?min-height:\s*44px/);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*?outline:\s*2px solid CanvasText/);
  });

  it('opts into OS text scaling without overriding the root font size', () => {
    expect(layout).toContain("'text-scale': 'scale'");
    expect(css).not.toMatch(/:root\s*{[^}]*font-size:/);
  });
});

describe('theme switching', () => {
  it('initializes before paint with a CSP nonce and no external script', () => {
    expect(layout).toContain('nonce={nonce}');
    expect(layout).toContain('cspHeaderName(CSP_MODE)');
    expect(layout).toContain('await headers()');
    expect(layout).toContain('solvi-theme');
    expect(layout).not.toMatch(/<script[^>]+src=/);
  });

  it('follows the OS setting by default and stores only the browser choice', () => {
    expect(themeToggle).toContain("'(prefers-color-scheme: dark)'");
    expect(themeToggle).toContain('window.localStorage.getItem');
    expect(themeToggle).toContain('window.localStorage.setItem');
    expect(themeToggle).toContain('catch');
    expect(themeToggle).not.toMatch(/fetch\(|document\.cookie/);
  });
});
