// NFR-UX-002: control boundaries and keyboard focus must stay perceivable.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'apps/web/src/app/freshservice.css'), 'utf8');
const layout = readFileSync(join(process.cwd(), 'apps/web/src/app/layout.tsx'), 'utf8');

const token = (name: string): string => {
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

describe('freshservice control affordances', () => {
  it('keeps control borders at 3:1 against the surface (WCAG 1.4.11)', () => {
    expect(contrast(token('fs-control-border'), token('fs-surface'))).toBeGreaterThanOrEqual(3);
  });

  it('shows a keyboard focus ring around the portal search', () => {
    expect(css).toContain('.support-search:focus-within');
    expect(css).toMatch(/\.support-search:focus-within\s*{[^}]*outline:/);
  });

  it('removes the closed mobile rail from the tab order and the accessibility tree', () => {
    const mobile = css.match(/@media \(max-width: 800px\)\s*{([\s\S]*?)\n}/)?.[1] ?? '';
    expect(mobile).toMatch(/\.fs-rail\s*{[^}]*visibility:\s*hidden/);
    expect(mobile).toMatch(/\.fs-app--rail-open \.fs-rail\s*{[^}]*visibility:\s*visible/);
  });

  it('uses at least 1rem input text to prevent iOS focus zoom', () => {
    const inputs = css.match(/body\.fs-ui input\[type='text'\],[\s\S]*?\n}/)?.[0] ?? '';
    expect(inputs).toContain('font-size: max(1rem, 1em)');
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
