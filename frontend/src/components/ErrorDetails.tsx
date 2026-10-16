/** The full text of an error (a conflict file list, say), behind a disclosure keyboard and touch can open. */
export function ErrorDetails({ message }: { message: string }) {
  return (
    <details className="w-full text-xs">
      <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring">
        Details
      </summary>
      <pre className="mt-1 font-mono text-xs whitespace-pre-wrap break-words">{message}</pre>
    </details>
  );
}
