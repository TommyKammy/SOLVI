'use client';

import { useEffect, useRef, useState } from 'react';

type Props = {
  selectedGroup: string;
  groups: ReadonlyArray<{ id: string; name: string }>;
  missingGroup: boolean;
  invalid: boolean;
  describedBy?: string;
};

/** Native history may restore the last edited select value, not the rendered scope. */
export function OperationsGroupSelect({
  selectedGroup,
  groups,
  missingGroup,
  invalid,
  describedBy,
}: Props) {
  const [value, setValue] = useState(selectedGroup);
  const select = useRef<HTMLSelectElement>(null);
  const restoreTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const restore = () => {
      // A restored DOM can differ even when React's value already equals this prop.
      if (select.current) select.current.value = selectedGroup;
      setValue(selectedGroup);
    };
    const restoreAfterHistory = () => {
      restore();
      window.clearTimeout(restoreTimer.current);
      // Browsers may restore persisted form values after the history event fires.
      restoreTimer.current = window.setTimeout(restore, 0);
    };
    restore();
    window.addEventListener('pageshow', restoreAfterHistory);
    window.addEventListener('popstate', restoreAfterHistory);
    return () => {
      window.clearTimeout(restoreTimer.current);
      window.removeEventListener('pageshow', restoreAfterHistory);
      window.removeEventListener('popstate', restoreAfterHistory);
    };
  }, [selectedGroup]);

  return (
    <select
      ref={select}
      id="overview-group"
      name="group"
      value={value}
      onChange={(event) => {
        window.clearTimeout(restoreTimer.current);
        setValue(event.currentTarget.value);
      }}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      <option value="">組織全体</option>
      <option value="mine">自分のグループ</option>
      <option value="ungrouped">グループ未割当</option>
      {groups.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name}
        </option>
      ))}
      {missingGroup && <option value={selectedGroup}>指定したグループ（名称未取得）</option>}
    </select>
  );
}
