/**
 * "/" is now the public landing page and the Overview lives at /overview. Launch links printed by older builds
 * (and bookmarks of them) point at "/?token=...": once the token has been captured, send those visitors to the app
 * instead of the landing page so the old link keeps opening the Overview.
 */
export function redirectLegacyLaunchToOverview(tokenCaptured: boolean, loc: Location = window.location, hist: History = window.history): boolean {
  if (!tokenCaptured) return false;
  if (loc.pathname !== "/" && loc.pathname !== "") return false;
  try {
    hist.replaceState(hist.state, "", `/overview${loc.search}${loc.hash}`);
    return true;
  } catch {
    return false;
  }
}
