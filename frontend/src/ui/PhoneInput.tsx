import type { InputHTMLAttributes } from 'react';
import { phoneInputValue } from '../app/phoneInput.mjs';

export function PhoneInput({ onChange, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} type="tel" inputMode="tel" onChange={event => {
    event.currentTarget.value = phoneInputValue(event.currentTarget.value);
    onChange?.(event);
  }} />;
}
