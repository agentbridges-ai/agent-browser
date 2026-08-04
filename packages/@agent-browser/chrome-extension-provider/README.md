# @agent-browser/chrome-extension-provider

Optional Chrome extension bridge provider for `agent-browser`.

This package lets `agent-browser` connect to the user's already running desktop Chrome through an unpacked MV3 extension. It exposes a `browser.provider` plugin that returns a local CDP WebSocket URL, while the bridge daemon translates CDP traffic to the extension's `chrome.debugger` transport.

## Install

```bash
pnpm add @agent-browser/chrome-extension-provider
```

Build the package if you are using it from a workspace checkout:

```bash
pnpm --filter @agent-browser/chrome-extension-provider build
```

Load the unpacked extension from:

```text
packages/@agent-browser/chrome-extension-provider/.output/chrome-mv3
```

## Configure agent-browser

Add the provider plugin:

```json
{
  "plugins": [
    {
      "name": "chrome-extension",
      "command": "agent-browser-plugin-chrome-extension",
      "capabilities": ["browser.provider", "command.run", "chrome-extension.manage"]
    }
  ]
}
```

Then run:

```bash
agent-browser --provider chrome-extension open https://example.com
agent-browser snapshot -i
```

## Status

Use the management command to see whether the daemon and extension profiles are connected:

```bash
agent-browser plugin run chrome-extension chrome-extension.status
```

The status output includes the unpacked extension path, bridge protocol version, daemon port, connected profile ids, extension id/version, and current tabs. Extension and daemon package versions are diagnostic only; compatibility is negotiated by the bridge protocol version so an automatically updated extension can remain compatible with an older daemon.

## Onboarding page and status badge

Clicking the "Agent Browser Bridge" toolbar action opens an onboarding page (`onboarding.html`) that shows the live bridge connection state. The page asks the background worker (which owns the bridge WebSocket) for the current status every 2 seconds, lists the expected daemon port from the same `chrome.storage.local.bridgePort`/`bridgePorts` candidates as the bridge connection, and shows setup guidance when the daemon is not running (the extension is a companion of the Nexolyra local workbench). While the bridge WebSocket is disconnected the toolbar action shows a red `OFF` badge, which clears as soon as the extension reconnects.

## Configuration

<table>
  <thead>
    <tr><th>Variable</th><th>Description</th><th>Default</th></tr>
  </thead>
  <tbody>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_PORT</code></td><td>Local daemon port</td><td><code>19826</code></td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_PROFILE</code></td><td>Profile id to use when multiple extension profiles are connected</td><td>Auto-selects when only one profile is connected</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT</code></td><td>Private pathname suffix used to identify the owning profile when several profiles are connected</td><td>Unset; an explicit profile is still required when selection remains ambiguous</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_RETURN_ORIGIN</code></td><td>Trusted loopback origin used by the human-control Return to Nexolyra action</td><td>Unset; the Return action is hidden</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_DAEMON</code></td><td>Override daemon executable path</td><td>Bundled daemon</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID</code></td><td>Require the WebSocket Origin and bridge hello to match one extension id</td><td>Bundled extension id (<code>pimcamjccpkgapdpecfiadkemnggggbj</code>)</td></tr>
    <tr><td><code>AGENT_BROWSER_CHROME_BRIDGE_LOG</code></td><td>Optional daemon log file</td><td>No file logging</td></tr>
  </tbody>
</table>

The extension connects to port `19826` by default. For a custom port, set `chrome.storage.local.bridgePort` or `chrome.storage.local.bridgePorts` in the extension profile to match `AGENT_BROWSER_CHROME_BRIDGE_PORT`.

When a host provides `AGENT_BROWSER_CHROME_BRIDGE_PROFILE_URL_HINT`, the bridge uses that private route only to find the owning Chrome profile. It does not expose the host tab to the agent. Instead, it creates non-focused task windows and limits the CDP session to tabs created for that session; human takeover focuses the exact controlled tab, and provider cleanup closes session-owned tabs. The Return target is accepted only for an HTTP(S) loopback origin, is sent to the extension only during human control, and stays in the extension worker. The untrusted page receives only a boolean indicating whether the Return button should be shown, never the Nexolyra session path.

Keyboard, mouse, and touch input activates the exact session-owned task tab immediately before dispatch, while the CDP command remains explicitly addressed to that tab. It does not steal operating-system focus from the user's current app. Human takeover is the separate focus-changing transition and is acknowledged only after Chrome confirms the exact task tab and window.

Reconnect restores transport into a fail-closed `resuming` phase rather than immediately reopening Agent control. In that phase the daemon accepts only the bounded CDP methods needed by `agent-browser snapshot --readback-only` and Live observation; general script evaluation, navigation and input remain blocked until the host confirms both the fresh semantic readback and handoff delivery. A detached session also requires an explicit reconnect target unless its task tab was already reattached by the host after an opaque identity match. The provider never treats “the only tab” or “the active tab” as sufficient ownership evidence.

When Nexolyra owns the daemon lifecycle it starts the process with an internal supervision marker. `/health` exposes that boolean so destructive development harnesses can refuse to restart an unmanaged daemon. The marker is operational metadata, not an authentication mechanism.

The daemon rejects `/bridge` upgrades unless the browser-supplied WebSocket Origin matches the pinned extension id, then checks the hello payload against the same id. Browser-origin requests are also rejected from host control routes; only the allowlisted extension origin can read the onboarding health route. Together these checks prevent an ordinary web page or a different installed extension from attaching to or mutating the local bridge. A custom development build can override the id explicitly. This is not authentication against a hostile process already executing as the same operating-system user, because such a process can forge loopback HTTP headers; Nexolyra's local single-user trust boundary remains the outer boundary.

The extension uses `chrome.debugger` as its session-scoped page-control transport and never requests blanket `<all_urls>` access. Its only host permission is `http://127.0.0.1/*`, used by the foreground onboarding page to reach the daemon health endpoint and obtain Chrome's Local Network Access grant. Browser commands, screenshots, and event-driven Live frames continue through the debugger session attached to the task tab.

Chrome 147 and newer gate WebSockets to loopback behind Local Network Access permission. A service worker cannot show that prompt itself, so a consumer install opens onboarding once and asks the user to allow the local connection before reconnecting the background bridge. Managed deployments may pregrant the extension origin with Chrome's `LoopbackNetworkAllowedForUrls` policy.

## Distribution identity

The checked-in manifest key keeps unpacked and self-hosted development builds on a stable extension id. Chrome Web Store signs extensions with a Store-owned key. Before the first unlisted Store release, maintainers must reserve the Store item, copy its public key into the manifest, update the pinned id in Nexolyra and enterprise policy, then rerun the real-browser release gates. After that one-time repin, unpacked, Store, and managed-install channels can share the Store identity.

## Limits

The MVP targets ordinary web pages in desktop Chrome 120 or newer. It does not support `chrome://` pages, browser UI pages, automation of other extension pages, Chrome Web Store distribution, Native Messaging bootstrap, or capabilities that are already incomplete for external CDP sessions such as some recording flows.

## Verification

Run the daemon and provider contract suite plus the production extension build:

```bash
pnpm --filter @agent-browser/chrome-extension-provider test
pnpm --filter @agent-browser/chrome-extension-provider build
```

The browser E2E can explicitly require the built extension instead of its daemon-only mock fallback:

```bash
AGENT_BROWSER_E2E_REQUIRE_REAL_EXTENSION=1 \
  pnpm --filter @agent-browser/chrome-extension-provider test:browser-e2e
```

The harness compiles `AGENT_BROWSER_E2E_BRIDGE_PORT` into its disposable extension build, so isolated ports exercise the real extension instead of silently connecting to the production default. On Chrome versions that gate loopback access, approve the Local Network Access prompt in the fresh test profile. With the strict flag, a missing extension connection fails rather than being reported as a real extension pass.

CI additionally pins Chrome for Testing `150.0.7871.24` and sets `AGENT_BROWSER_E2E_HEADLESS=1`, `AGENT_BROWSER_E2E_BYPASS_LNA=1`, and `AGENT_BROWSER_E2E_DISABLE_CHROME_SANDBOX=1`. The last two variables disable Chrome's Local Network Access checks and process sandbox only inside the disposable Linux CI browser so extension code is exercised without an interactive permission prompt and can start on an unprivileged hosted runner. Local and release validation must not set the sandbox bypass and must still run the headed persistent-profile bootstrap and fresh-profile GUI gate to cover the real permission experience.
