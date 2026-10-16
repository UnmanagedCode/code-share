import { useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { errorMessage } from '@/lib/usePoll';

const QUIET = 4; // modules of white border scanners need

/** `text` as a QR code (level M), drawn as SVG elements. Black on white whatever the theme: scanners need it. */
export function QrCode({ text }: { text: string }) {
  const qr = useMemo(() => {
    try {
      const q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      }
      return { size: n + 2 * QUIET, d };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }, [text]);

  if ('error' in qr) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Could not generate QR code: {qr.error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="w-fit rounded-lg border bg-card p-3">
      <svg
        role="img"
        aria-label="QR code for the connect link"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
        className="block aspect-square w-64 max-w-full"
      >
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path fill="#000" d={qr.d} />
      </svg>
    </div>
  );
}
