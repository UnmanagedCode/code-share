import { useId, useState, type FormEvent } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ActionButton } from '@/components/ActionButton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Section } from '@/components/Section';
import { api } from '@/lib/api';
import { parsePeerInput } from '@/lib/connectionString';
import { errorMessage } from '@/lib/usePoll';

type Outcome = { kind: 'error'; text: string } | { kind: 'ok' } | null;

/** "Connect a Peer": paste a peer's cs1: string (or authed URL) and name it locally. */
export function ConnectCard({ refreshAll }: { refreshAll: () => Promise<void> }) {
  const [cs, setCs] = useState('');
  const [name, setName] = useState('peer');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const csId = useId();
  const nameId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const parsed = parsePeerInput(cs);
    if (!parsed.ok) {
      setOutcome({ kind: 'error', text: parsed.error });
      return;
    }
    setOutcome(null);
    setBusy(true);
    try {
      await api('api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: parsed.url, token: parsed.token, name: name.trim() || 'peer' }),
      });
      setCs(''); // it carries the peer's token
      setOutcome({ kind: 'ok' });
      void refreshAll();
    } catch (err) {
      setOutcome({ kind: 'error', text: `Error: ${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Connect a Peer">
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div className="grid gap-2">
          <Label htmlFor={csId}>Connection string (paste peer's cs1:… string)</Label>
          <Input
            id={csId}
            className="font-mono"
            placeholder="cs1:…"
            autoComplete="off"
            spellCheck={false}
            value={cs}
            onChange={(e) => setCs(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={nameId}>Peer name (local label)</Label>
          <Input id={nameId} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <ActionButton type="submit" busy={busy}>
          {busy && <LoaderCircleIcon className="animate-spin" />}
          {busy ? 'Connecting…' : 'Connect'}
        </ActionButton>
        {outcome?.kind === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{outcome.text}</AlertDescription>
          </Alert>
        )}
        {outcome?.kind === 'ok' && (
          <p role="status" className="text-sm text-success">
            Connected! Toggle the Leader checkbox per project if needed.
          </p>
        )}
      </form>
    </Section>
  );
}
