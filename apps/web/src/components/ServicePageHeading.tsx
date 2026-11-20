import React, { type ReactNode } from 'react';

export function ServicePageHeading({
  title,
  back,
  meta,
  actions,
  pageIntro = false,
}: {
  title: ReactNode;
  back?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  pageIntro?: boolean;
}) {
  return (
    <header className={pageIntro ? 'service-page-heading work-page-tools' : 'service-page-heading'}>
      {back}
      <div className="service-heading-line">
        <div className={pageIntro ? 'work-page-copy' : undefined}>
          {meta && <p className="service-heading-meta">{meta}</p>}
          <h1 className={pageIntro ? 'work-page-title' : undefined}>{title}</h1>
        </div>
        {actions && <div className="service-heading-actions">{actions}</div>}
      </div>
    </header>
  );
}
