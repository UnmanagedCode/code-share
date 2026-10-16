import { expect, it } from 'vitest';
import { render } from '@testing-library/react';
import qrcode from 'qrcode-generator';
import { QrCode } from './QrCode';

const TEXT = 'http://192.168.1.20:9419/connect#eyJ1cmwiOiJodHRwOi8vMTkyLjE2OC4xLjIwOjk0MTkifQ';

// Invariant: the SVG draws exactly the level-M matrix, offset by a 4-module white quiet zone, black on white.
it('draws the level-M matrix with a 4-module quiet zone', () => {
  const { container } = render(<QrCode text={TEXT} />);
  const q = qrcode(0, 'M');
  q.addData(TEXT);
  q.make();
  const n = q.getModuleCount();
  const svg = container.querySelector('svg')!;
  expect(svg.getAttribute('viewBox')).toBe(`0 0 ${n + 8} ${n + 8}`);
  expect(svg.getAttribute('role')).toBe('img');
  expect(svg.getAttribute('aria-label')).toBe('QR code for the connect link');
  expect(container.querySelector('rect')?.getAttribute('fill')).toBe('#fff');
  const path = container.querySelector('path')!;
  expect(path.getAttribute('fill')).toBe('#000');
  const drawn = new Set([...path.getAttribute('d')!.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => `${m[2]},${m[1]}`));
  const dark = new Set<string>();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) dark.add(`${r + 4},${c + 4}`);
  expect(drawn).toEqual(dark);
});

// Invariant: text the QR cannot hold reports "Could not generate QR code: <msg>" instead of throwing.
it('reports a generation failure', () => {
  const { container } = render(<QrCode text={'x'.repeat(5000)} />);
  expect(container.querySelector('svg')).toBeNull();
  expect(container.textContent).toMatch(/^Could not generate QR code: .+/);
});
