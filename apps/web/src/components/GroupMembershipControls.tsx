'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export function GroupMembershipControls({
  operation,
  children,
}: {
  operation: 'add' | 'remove';
  children: ReactNode;
}) {
  const { pending } = useFormStatus();

  return (
    <fieldset
      disabled={pending}
      style={{
        border: 0,
        margin: 0,
        padding: 0,
        ...(operation === 'add'
          ? { display: 'flex', flexDirection: 'column', gap: '1.25rem' }
          : {}),
      }}
    >
      {children}
      {pending && (
        <p className="hint" role="status">
          {operation === 'add'
            ? 'グループに追加しています。完了するまでお待ちください。'
            : 'グループから外しています。完了するまでお待ちください。'}
        </p>
      )}
    </fieldset>
  );
}
