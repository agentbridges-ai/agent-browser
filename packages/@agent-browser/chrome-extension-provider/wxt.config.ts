import { defineConfig } from "wxt";

const configuredBridgePort = Number(process.env.AGENT_BROWSER_E2E_BRIDGE_PORT ?? 19826);
const defaultBridgePort =
  Number.isInteger(configuredBridgePort) && configuredBridgePort > 0 && configuredBridgePort <= 65535
    ? configuredBridgePort
    : 19826;

export default defineConfig({
  vite: () => ({
    define: {
      __AGENT_BROWSER_BRIDGE_DEFAULT_PORT__: JSON.stringify(defaultBridgePort),
    },
  }),
  manifest: {
    name: "Agent Browser Bridge",
    version: "0.33.2",
    minimum_chrome_version: "120",
    permissions: ["debugger", "tabs", "storage", "alarms"],
    // This narrow grant is only for onboarding's loopback health probe. Page
    // automation remains scoped to per-tab chrome.debugger sessions; the
    // extension never receives blanket access to users' browsing origins.
    host_permissions: ["http://127.0.0.1/*"],
    // Pins the current unpacked/self-hosted identity. Chrome Web Store assigns
    // its own signing identity: before the first Store release, reserve the
    // listing, replace this key with the Store-provided public key, and repin
    // Nexolyra's release manifest once. The matching development private key
    // lives outside this repository and is not needed by extension clients.
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqMfykuer8LcTC3oEsE6DYk5Fnq2WWVX31WX6Jyz8KQY0ItnG9qOjBj2uzHrE6mjcMsVx5D3pg7MRRpnDqb84nx5HA1g79pbsU/uD53Rzm3asGiHBHLNgGZHvMfb5GDHVM1wGVUbzRqGF50rh0fOk2oxSNBDQCLTjoGaNhe7VCHeJ2OWL88fGOAlPWE1zD+7x1WIpaU9Q6mVhx2Dofx4tZH04k4711l9NpyFJJCoRO93dMT40+9unxB3tfoahOlMIeRfw80Gw67+gZPiFLkZnaVDWo0wlBbEU/BvtRDI9DxiXu3tQTHfFUdHxYQbpq2TEVxA6kvpUdw6VcnihLcGFCQIDAQAB",
    action: {
      default_title: "Agent Browser Bridge",
    },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    },
  },
});
