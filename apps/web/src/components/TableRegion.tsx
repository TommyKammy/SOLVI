import type { ReactNode } from 'react';
/** Keep wide tables locally scrollable and reachable by keyboard. */
export function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
