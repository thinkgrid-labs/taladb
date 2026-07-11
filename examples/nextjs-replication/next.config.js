const path = require('path');

// `taladb`'s default (`import`) condition pulls in the native `@taladb/node`
// addon, so Next's server compile of the client components tries to bundle the
// `.node` binary and fails. This is a browser app — the DB lives in OPFS and
// opens on the client only — so resolve `taladb` to its stubbed `browser` build
// everywhere. (`browser` is already used for the client bundle; this extends it
// to the SSR/server compile too.) exports() blocks the subpath, so alias the
// file directly via its workspace path.
const taladbBrowser = path.resolve(
  __dirname,
  '../../packages/clients/taladb/dist/index.browser.mjs',
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      taladb$: taladbBrowser,
    };
    return config;
  },
};

module.exports = nextConfig;
