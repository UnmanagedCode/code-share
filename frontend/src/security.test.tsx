import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { baseRoutes, fail, makeStatus, stubApi } from '@/test/api';

afterEach(() => vi.unstubAllGlobals());

const IMG = '<img src=x onerror=alert(1)>';
const SCRIPT = '"><script>alert(1)</script>';

// Invariant: names, paths, URLs and error messages from the backend or a peer render as text, never as elements.
it('renders hostile content as text', async () => {
  stubApi({
    ...baseRoutes(
      makeStatus({
        projectsRoot: `/srv/${SCRIPT}`,
        peers: [{ name: IMG, url: `http://h/${SCRIPT}` }],
        shared: [{ name: IMG, path: `/srv/${SCRIPT}`, peers: [{ name: IMG }] }],
      }),
      [{ name: IMG, path: `/srv/${SCRIPT}`, shared: true }],
    ),
    'GET api/peer-status': { shared: [{ name: IMG }, { name: `<b>${SCRIPT}</b>` }] },
    'GET api/sync-status': fail(500, `<img src=x onerror=alert(2)>${SCRIPT}`),
    'POST api/clone': fail(500, `<iframe src="javascript:alert(3)">`),
  });
  const user = userEvent.setup();
  const { container } = render(<App />);
  const peers = screen.getByRole('region', { name: 'Connected Peers' });
  await user.click(await within(peers).findByRole('button', { name: `Fetch ${IMG} from ${IMG}` }));
  await within(peers).findByText('err');
  await user.click(within(peers).getByRole('button', { name: `Clone <b>${SCRIPT}</b> from ${IMG}` }));
  await within(peers).findByText('clone failed');

  expect(container.querySelector('img, script, iframe, b')).toBeNull();
  expect(container.querySelector('a')).toBeNull();
  expect(screen.getAllByText(IMG).length).toBeGreaterThanOrEqual(3);
  expect(container.textContent).toContain(`<img src=x onerror=alert(2)>${SCRIPT}`);
  expect(container.textContent).toContain('<iframe src="javascript:alert(3)">');
});
