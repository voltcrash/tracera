import { defineConfig } from "wxt";

// This public key pins Tracera's Chrome extension ID across local and release
// builds. Its matching private key is intentionally kept outside Git.
const productionExtensionPublicKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApjhjnsBLF0ZG7C3K7/JYHfhQ1GgSJIz4kywTKcAH2krZxpxwu2d33tGVa+fHR1s1gJcibUh2fuaYowPkM2nnkEYEaFDbudVW5hcP96npnMwfJ2RHnImurXd3IG9SiT0tuLJgXJFlIlE1gJr1BkoIaRXBx0omV6l42o5HvmXmLl3/MQDSfNxhW1xpOYRl5ztSwRaSQ36SVeiz45DxuQzoNjxvcvnrtUk4AK89ejhfk15GdL70F54NfYptGy5O5348r3SY3X4FMbCp/niucehOwmIkxBHK9Pi0EUOigf+IFvm32llnp2Hoh4PZCiX+T1bWyoAQ10vza3RUKZVH+AfiLQIDAQAB";

export default defineConfig({
  manifest: () => {
    const traceraHost = "https://tracera.voltcrash.com/*";
    return {
      name: "Tracera",
      description: "Trace the evidence behind the article you are reading.",
      permissions: ["activeTab", "cookies", "scripting", "storage"],
      key: import.meta.env.WXT_EXTENSION_PUBLIC_KEY || productionExtensionPublicKey,
      // Reading an article from the side panel needs an explicit page host grant.
      // `activeTab` alone is not reliably retained after Chrome opens a side panel.
      // Tracera analyzes public news pages, so support both public web schemes.
      host_permissions: ["http://*/*", "https://*/*", traceraHost],
      action: {
        default_title: "Analyze this page with Tracera",
        default_icon: {
          16: "icons/16.png",
          32: "icons/32.png",
          48: "icons/48.png",
          128: "icons/128.png",
        },
      },
      icons: {
        16: "icons/16.png",
        32: "icons/32.png",
        48: "icons/48.png",
        128: "icons/128.png",
      },
    };
  },
});
