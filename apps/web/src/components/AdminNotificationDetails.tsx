'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type NotificationDetail = {
  title: string;
  facts: Array<{ label: string; value: string }>;
};

const headingId = 'notification-detail';
const panelId = 'notification-detail-panel';
const Workspace = createContext<{
  active: number | null;
  open: (row: number, record: NotificationDetail, trigger: HTMLButtonElement) => void;
} | null>(null);

export function AdminNotificationDetails({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<{ row: number; record: NotificationDetail } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (selection) {
      headingRef.current?.focus();
    } else {
      triggerRef.current?.focus();
    }
  }, [selection]);

  function open(row: number, record: NotificationDetail, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setSelection({ row, record });
  }

  return (
    <Workspace.Provider value={{ active: selection?.row ?? null, open }}>
      <div className={selection ? 'admin-split' : undefined}>
        {children}
        {selection && (
          <section id={panelId} className="admin-panel admin-detail-panel" aria-labelledby={headingId}>
            <div className="directory-detail-heading">
              <h2 id={headingId} tabIndex={-1} ref={headingRef}>
                {selection.record.title}
              </h2>
              <button type="button" className="secondary" onClick={() => setSelection(null)}>
                詳細を閉じる
              </button>
            </div>
            <dl className="admin-record">
              {selection.record.facts.map(({ label, value }) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </Workspace.Provider>
  );
}

export function AdminNotificationDetailButton({
  row,
  record,
}: {
  row: number;
  record: NotificationDetail;
}) {
  const workspace = useContext(Workspace);
  const expanded = workspace?.active === row;

  return (
    <button
      type="button"
      className="notification-event admin-notification-detail-button"
      aria-expanded={expanded}
      aria-controls={expanded ? panelId : undefined}
      onClick={(event) => workspace?.open(row, record, event.currentTarget)}
    >
      {record.title}
    </button>
  );
}
