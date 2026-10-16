import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { CopyButton } from '@/components/CopyButton';
import { decodePayload } from '@/lib/connectionString';

type View = { kind: 'loading' } | { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; cs: string };

/** The fragment is read once: it carries the token so it never reaches a server, and it is never written. */
function readView(hash: string): View {
  const payload = hash.slice(1);
  if (!payload) return { kind: 'none' };
  return decodePayload(payload) ? { kind: 'ok', cs: 'cs1:' + payload } : { kind: 'invalid' };
}

/** The public landing page a scanned QR opens: shows the `cs1:` string to paste. It never connects anything. */
export function ConnectPage() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const csRef = useRef<HTMLDivElement>(null);
  useEffect(() => setView(readView(location.hash)), []);

  return (
    <main className="mx-auto max-w-xl space-y-4 p-4 sm:p-6">
      <h1 className="text-xl font-semibold">code-share connection</h1>
      {view.kind === 'loading' && <p className="text-muted-foreground">Reading connection data…</p>}
      {view.kind === 'none' && <Problem text="No connection data in this link." />}
      {view.kind === 'invalid' && <Problem text="Could not read connection data from this link." />}
      {view.kind === 'ok' && (
        <>
          <p className="leading-relaxed text-muted-foreground">
            Paste this connection string into the <strong className="text-foreground">Connect</strong> box on{' '}
            <em>your own</em> code-share instance's web UI. Scanning this code does not connect anything
            automatically.
          </p>
          <Card>
            <CardContent className="space-y-3">
              <div ref={csRef} className="font-mono text-xs break-all">
                {view.cs}
              </div>
              <CopyButton text={view.cs} target={csRef} variant="outline" />
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}
