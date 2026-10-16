import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionButton } from './ActionButton';

function Harness({ onRun, onSubmit }: { onRun: () => void; onSubmit: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <ActionButton type="button" busy={busy} onClick={() => { onRun(); setBusy(true); }}>Fetch</ActionButton>
      <ActionButton type="submit" busy={busy}>Go</ActionButton>
    </form>
  );
}

// Invariant: a button that turns busy keeps keyboard focus (it is aria-disabled, not disabled) and ignores further
// activation, including a busy submit button's form submission.
it('stays focused and inert while busy', async () => {
  const onRun = vi.fn();
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<Harness onRun={onRun} onSubmit={onSubmit} />);
  const fetchBtn = screen.getByRole('button', { name: 'Fetch' });
  fetchBtn.focus();
  await user.keyboard('{Enter}');
  expect(onRun).toHaveBeenCalledTimes(1);
  expect(fetchBtn.getAttribute('aria-disabled')).toBe('true');
  expect((fetchBtn as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(fetchBtn);
  await user.keyboard('{Enter}');
  await user.click(fetchBtn);
  expect(onRun).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Go' }));
  expect(onSubmit).not.toHaveBeenCalled();
});
