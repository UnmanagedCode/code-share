import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A Button that stays focusable while `busy`: it is aria-disabled, looks disabled and ignores activation. A control
 * that becomes `disabled` drops keyboard focus to the page, so a busy state must not use `disabled`.
 */
export function ActionButton({ busy, onClick, className, ...props }: ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button
      {...props}
      aria-disabled={busy || undefined}
      className={cn(busy && 'cursor-not-allowed opacity-50', className)}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    />
  );
}
