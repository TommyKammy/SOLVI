// NFR-UX-001/NFR-UX-002: wide tables stay keyboard-scrollable and named.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const files = walk(join(process.cwd(), 'apps/web/src')).filter((file) => file.endsWith('.tsx'));
const tableFiles = files.filter((file) => readFileSync(file, 'utf8').includes('<table'));

describe('every table keeps its header context and keyboard scroll region', () => {
  it('finds the application tables', () => {
    expect(tableFiles.length).toBeGreaterThan(0);
  });

  it.each(tableFiles.map((file) => [file.replace(process.cwd() + '/', ''), file]))(
    '%s wraps each table in TableRegion and gives it a caption',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const tables = (source.match(/<table\b/g) ?? []).length;
      const regions = (source.match(/<TableRegion\b/g) ?? []).length;
      const captions = (source.match(/<caption\b/g) ?? []).length;
      expect(regions, 'TableRegion count').toBe(tables);
      expect(captions, 'caption count').toBe(tables);
    },
  );
});
