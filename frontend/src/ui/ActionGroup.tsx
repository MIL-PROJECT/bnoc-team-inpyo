import type { HTMLAttributes } from 'react';

export function ActionGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={['ui-action-group', className].filter(Boolean).join(' ')} />;
}
