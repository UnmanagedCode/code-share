import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LoaderCircleIcon, QrCodeIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionButton } from '@/components/ActionButton';
import { CopyButton } from '@/components/CopyButton';
import { QrCode } from '@/components/QrCode';
import { Section } from '@/components/Section';
import { RefreshNotice, SectionState } from '@/components/SectionState';
import { api } from '@/lib/api';
import { makeConnectionString, qrTextFor } from '@/lib/connectionString';
import type { Status } from '@/lib/types';
import { errorMessage, type Polled } from '@/lib/usePoll';
import { cn } from '@/lib/utils';

const NONE = '—';

/** "Your Link": this instance's URLs, its cs1: connection string with a QR code, and the tunnel control. */
export function LinkCard({ status }: { status: Polled<Status> }) {
  const s = status.data;
  const cs = s ? makeConnectionString(s.tunnelUrl || s.selfUrl, s.token) : null;
  const [tunnelOp, setTunnelOp] = useState<'starting' | 'stopping' | null>(null);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const qrPanel = useId();
  useEffect(() => {
    if (!cs) setQrOpen(false);
  }, [cs]);

  const starting = tunnelOp === 'starting' || (!!s?.tunnelStarting && tunnelOp !== 'stopping');
  const stopping = tunnelOp === 'stopping';
  const hasTunnel = !!s?.tunnelUrl;

  const toggleTunnel = async () => {
    const stop = hasTunnel;
    setTunnelError(null);
    setTunnelOp(stop ? 'stopping' : 'starting');
    try {
      if (stop) await api('api/tunnel/stop', { method: 'POST' });
      else
        await api('api/tunnel/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'cloudflared' }),
        });
    } catch (e) {
      setTunnelError(errorMessage(e));
    } finally {
      await status.refresh();
      setTunnelOp(null);
    }
  };

  const tunnelButton = (
    <ActionButton
      type="button"
      size="sm"
      variant={hasTunnel && !starting && !stopping ? 'destructive' : 'outline'}
      disabled={!s}
      busy={starting || stopping}
      onClick={toggleTunnel}
    >
      {(starting || stopping) && <LoaderCircleIcon className="animate-spin" />}
      {starting ? 'Starting… (up to 30s)' : stopping ? 'Stopping…' : hasTunnel ? 'Stop tunnel' : 'Start tunnel'}
    </ActionButton>
  );

  return (
    <Section title="Your Link">
      <dl className="space-y-3">
        <Row label="Status">
          {s ? (
            <Badge variant="success">serving</Badge>
          ) : status.error ? (
            <div className="w-full">
              <SectionState state="error" message={status.error} onRetry={status.refresh} />
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">Loading…</span>
          )}
        </Row>
        <ValueRow label="LAN URL" value={s?.selfUrl || null} />
        <ValueRow label="Tunnel URL" value={s?.tunnelUrl || null}>
          {tunnelButton}
          {tunnelError && (
            <Alert variant="destructive" className="w-full">
              <AlertDescription>{tunnelError}</AlertDescription>
            </Alert>
          )}
        </ValueRow>
        <ValueRow label="Connection" value={cs} placeholder="— (start tunnel or connect LAN first)">
          <Button
            type="button"
            size="sm"
            variant={qrOpen ? 'secondary' : 'outline'}
            disabled={!cs}
            aria-expanded={qrOpen}
            aria-controls={qrPanel}
            onClick={() => setQrOpen((o) => !o)}
          >
            <QrCodeIcon />
            {qrOpen ? 'Hide QR' : 'Show QR'}
          </Button>
        </ValueRow>
      </dl>
      <div id={qrPanel} hidden={!(qrOpen && cs)}>
        {qrOpen && cs && <QrCode text={qrTextFor(cs)} />}
      </div>
      <RefreshNotice message={status.refreshError} />
    </Section>
  );
}

/** Label above the value on a phone, beside it from `sm` up. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_1fr] sm:gap-3">
      <dt className="text-sm text-muted-foreground sm:pt-1.5">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

/** A copyable value; with none, `placeholder` (muted) and a disabled Copy. */
function ValueRow({ label, value, placeholder = NONE, children }: { label: string; value: string | null; placeholder?: string; children?: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <Row label={label}>
      <span ref={ref} className={cn('w-full font-mono text-xs break-all sm:w-auto sm:flex-1', !value && 'text-muted-foreground')}>
        {value ?? placeholder}
      </span>
      <CopyButton text={value ?? ''} target={ref} what={label} disabled={!value} />
      {children}
    </Row>
  );
}
