import type { ReactNode } from 'react';

export function ActionRow({ children, actions, details, className }: {
  children: ReactNode;
  actions?: ReactNode;
  details?: ReactNode;
  className?: string;
}) {
  return <article className={['ui-action-row', className].filter(Boolean).join(' ')} data-has-actions={Boolean(actions)}>
    <div className="ui-action-row__main">{children}</div>
    {actions && <div className="ui-action-row__actions">{actions}</div>}
    {details && <div className="ui-action-row__details">{details}</div>}
  </article>;
}
