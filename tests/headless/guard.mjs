// Playwright globalSetup: refuse to touch the user's real display unless explicitly asked to.
export default function guard() {
  const e = process.env;
  if (e.P2P_E2E_DISPLAY === 'real') return; // `npm run test:display`
  if (e.P2P_E2E_HEADLESS !== '1' || e.WAYLAND_DISPLAY || e.HYPRLAND_INSTANCE_SIGNATURE) {
    throw new Error('e2e must run inside the private headless session: use `npm run test:e2e` (or `npm test`). ' +
      'To deliberately use the real display: `npm run test:display`.');
  }
}
