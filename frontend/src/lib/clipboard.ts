/**
 * Copies `text`; true on success. Where the Clipboard API is missing (a plain-http
 * LAN page is not a secure context) or refuses, selects `el`'s text instead so the
 * user can copy it by hand, and returns false.
 */
export async function copyText(text: string, el: HTMLElement | null): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return false;
  }
}
