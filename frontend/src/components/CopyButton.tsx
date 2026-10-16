import { useEffect, useRef, useState, type RefObject } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';

const FEEDBACK_MS = { copied: 2000, failed: 5000 } as const;

/** Copies `text`; on failure selects `target`'s text. The outcome shows on the button and is announced. */
export function CopyButton({
  text,
  target,
  disabled,
  variant = 'ghost',
}: {
  text: string;
  target: RefObject<HTMLElement | null>;
  disabled?: boolean;
  variant?: 'ghost' | 'outline';
}) {
  const [outcome, setOutcome] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(text, target.current);
    const next = ok ? 'copied' : 'failed';
    setOutcome(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome(null), FEEDBACK_MS[next]);
  };

  const label = outcome === 'copied' ? 'Copied' : outcome === 'failed' ? "Couldn't copy — text selected" : 'Copy';
  return (
    <>
      <Button type="button" variant={variant} size="sm" disabled={disabled} onClick={onClick}>
        {outcome === 'copied' ? <CheckIcon /> : <CopyIcon />}
        {label}
      </Button>
      <span className="sr-only" role="status">
        {outcome ? label : ''}
      </span>
    </>
  );
}
