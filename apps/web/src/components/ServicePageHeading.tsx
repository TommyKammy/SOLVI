import React, { type ReactNode } from 'react';

export function ServicePageHeading({
  title,
  back,
  meta,
  description,
  actions,
}: {
  title: ReactNode;
  back?: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="service-page-heading">
      {back}
      <div className="service-heading-line">
        <div>
          {meta && <p className="service-heading-meta">{meta}</p>}
          <h1>{title}</h1>
          {description && <p className="service-heading-description">{description}</p>}
        </div>
        {actions && <div className="service-heading-actions">{actions}</div>}
      </div>
    </header>
  );
}
