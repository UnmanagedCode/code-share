import { RefreshCwIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/** A section's loading, empty or failed state. */
export function SectionState(
  props: { state: 'loading' } | { state: 'empty'; text: string } | { state: 'error'; message: string; onRetry: () => void },
) {
  if (props.state === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    );
  }
  if (props.state === 'empty') return <p className="text-sm text-muted-foreground">{props.text}</p>;
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center gap-2">
        <span>Error: {props.message}</span>
        <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
          <RefreshCwIcon />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** A refresh failed after data had loaded: the section keeps its last data and says so. */
export function RefreshNotice({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="status" className="text-xs text-muted-foreground">
      Couldn't refresh: {message}
    </p>
  );
}
