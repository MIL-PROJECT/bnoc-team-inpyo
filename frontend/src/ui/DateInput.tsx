import type { InputHTMLAttributes } from 'react';

type DateInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function DateInput({ className, ...props }: DateInputProps) {
  return <input {...props} type="date" className={['ui-date-input', className].filter(Boolean).join(' ')} />;
}
