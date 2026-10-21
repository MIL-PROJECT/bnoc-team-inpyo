import type { ButtonHTMLAttributes } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'danger';
};

export function Button({ variant, className, type = 'button', ...props }: ButtonProps) {
  const classes = ['ui-button', variant && `ui-button--${variant}`, className].filter(Boolean).join(' ');
  return <button {...props} type={type} className={classes} />;
}
