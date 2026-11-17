import React, { type ReactNode } from 'react';
/** Keep wide tables locally scrollable and reachable by keyboard. */
export function TableRegion({
  label,
  children,
  className = 'table-scroll',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
