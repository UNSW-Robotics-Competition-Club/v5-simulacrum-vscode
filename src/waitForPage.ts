// Wait until one of the simulator's pages answers (no VS Code imports: tested
// under Node). The robot sim's HTTP server starts a few seconds after
// v5brain.sh announces the instance, so a pane opened right away would get a
// refused connection and stay blank.

export async function waitForPage(url: string, timeoutMs = 60_000, everyMs = 500,
                                  stillWanted: () => boolean = () => true): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stillWanted()) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) return true;
    } catch {
      // not listening yet
    }
    await new Promise(ok => setTimeout(ok, everyMs));
  }
  return false;
}
