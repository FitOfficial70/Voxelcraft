# Voxelcraft Account and Cloud Save Plan

## Approved product behavior

Voxelcraft will require a player account before gameplay. The home screen will present separate Sign In and Sign Up tabs. Both tabs will use secure Manus OAuth; Sign Up is the new-player path and creates the player record after the OAuth account is completed. The application will keep the website private to Manus-authorized visitors unless visibility is changed separately.

After authentication, cloud save is mandatory and has no in-game off switch. Worlds are owned by the authenticated player, loaded from the managed database, and saved through the server API. On first login, the current browser worlds are migrated once when the account has no cloud worlds. Settings will show the signed-in account, cloud-save status, and a confirmed Delete action for each owned world. Deleting a world removes only that player's world record and does not affect another account.

## Implementation approach

The current static Python server will be replaced by a small Node HTTP server. It will serve the existing `site/` files, implement the Manus OAuth callback and application session using the required `webdev_app_session` cookie, validate the project JWT with `MANUS_JWT_SECRET`, and expose authenticated JSON endpoints for account state and world CRUD. The server will use the managed MySQL `DATABASE_URL` with additive startup schema creation for users and worlds.

The browser game will retain its existing localStorage format as a one-time migration source and offline-friendly cache, but authenticated gameplay will synchronize the active world to the cloud. The UI will gate Play until authentication is ready, show account tabs and cloud status, load the account's worlds before play, and expose destructive world deletion only through a confirmation step in Settings.

## Project structure

- `index.html`: game UI, account tabs, auth gate, cloud-save synchronization, world deletion controls, and existing WebGL/WebXR/mobile gameplay.
- `server.js`: static-file server, Manus OAuth/session flow, database schema bootstrap, account API, and authenticated world CRUD API.
- `site/`: production static assets served by the Node server.
- `Dockerfile`: production image installation and server entrypoint.
- `package.json` / `package-lock.json`: pinned Node runtime and MySQL dependency.
- `TODO.md`: approved product outcomes and delivery state.

## Design decisions

- **Design movement:** “Account-bound voxel workshop” — 0.07 probability.
- **Alternative:** “Quiet secure game portal” — 0.06 probability.
- **Alternative:** “Classic console profile screen” — 0.05 probability.

The chosen direction is a restrained voxel-console account layer: the existing pixel UI remains intact, account tabs use the same blocky button language, cloud-save state is always visible, and destructive actions require plain-language confirmation. The signature color remains Voxelcraft gold for account identity and green for safe primary actions. Microcopy is direct: “Cloud Save: ON — required for this account” and “Delete this world from your account? This cannot be undone.”
