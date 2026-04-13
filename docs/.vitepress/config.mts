import { defineConfig, type HeadConfig } from "vitepress";

const title = "TalaDB";
const description =
  "Local-first document + vector database built in Rust. MongoDB-like API for browser (WASM + OPFS), Node.js, and React Native — zero cloud, zero GC.";
const siteUrl = "https://thinkgrid-labs.github.io/taladb";
const ogImage = `${siteUrl}/tala-db-banner.png`;

export default defineConfig({
  title,
  description,
  base: "/taladb/",
  appearance: false,

  // Canonical URL injected into every page <head>
  transformHead({ pageData }) {
    const canonicalUrl = `${siteUrl}/${pageData.relativePath}`
      .replace(/index\.md$/, "")
      .replace(/\.md$/, "");

    const tags: HeadConfig[] = [
      ["link", { rel: "canonical", href: canonicalUrl }],
    ];

    // Per-page Open Graph overrides
    const pageTitle = pageData.frontmatter.title
      ? `${pageData.frontmatter.title} | ${title}`
      : title;
    const pageDescription = pageData.frontmatter.description ?? description;

    tags.push(
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:url", content: canonicalUrl }],
      ["meta", { property: "og:title", content: pageTitle }],
      ["meta", { property: "og:description", content: pageDescription }],
      ["meta", { property: "og:image", content: ogImage }],
      ["meta", { property: "og:site_name", content: title }],

      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      ["meta", { name: "twitter:title", content: pageTitle }],
      ["meta", { name: "twitter:description", content: pageDescription }],
      ["meta", { name: "twitter:image", content: ogImage }],
    );

    return tags;
  },

  head: [
    // Google Analytics
    ["script", { async: "", src: "https://www.googletagmanager.com/gtag/js?id=G-SWTD98L8XR" }],
    ["script", {}, "window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','G-SWTD98L8XR');"],
    [
      "link",
      { rel: "icon", href: "/taladb/favicon.png", type: "image/png" },
    ],
    ["link", { rel: "apple-touch-icon", href: "/taladb/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#B54B31" }],
    ["meta", { name: "author", content: "thinkgrid-labs" }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "local-first database, rust database, wasm database, react native database, embedded database, nosql, offline-first, taladb",
      },
    ],
    // Prevent indexing until stable release — remove before 1.0
    // ['meta', { name: 'robots', content: 'noindex' }],
  ],

  sitemap: {
    hostname: siteUrl,
  },

  themeConfig: {
    logo: { src: "/tala-db.png", alt: "TalaDB logo" },
    siteTitle: false,

    nav: [
      { text: "Introduction", link: "/introduction" },
      { text: "Guides", link: "/guide/web" },
      { text: "API Reference", link: "/api/collection" },
      { text: "Roadmap", link: "/roadmap" },
      { text: "Live Demo", link: "https://taladb-playground.vercel.app/" },
      {
        text: "v0.6.1",
        items: [
          {
            text: "Changelog",
            link: "https://github.com/thinkgrid-labs/taladb/releases",
          },
          {
            text: "Contributing",
            link: "https://github.com/thinkgrid-labs/taladb/blob/main/CONTRIBUTING.md",
          },
        ],
      },
    ],

    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Introduction", link: "/introduction" },
          { text: "Core Concepts", link: "/concepts" },
          { text: "Features", link: "/features" },
        ],
      },
      {
        text: "Platform Guides",
        items: [
          { text: "Web (Browser / WASM)", link: "/guide/web" },
          { text: "Node.js", link: "/guide/node" },
          { text: "React Native", link: "/guide/react-native" },
          { text: "CLI Dev Tools", link: "/guide/cli" },
          { text: "HTTP Push Sync", link: "/guide/http-sync" },
        ],
      },
      {
        text: "Packages",
        items: [
          { text: "React Hooks (@taladb/react)", link: "/guide/react" },
        ],
      },
      {
        text: "API Reference",
        items: [
          { text: "Collection", link: "/api/collection" },
          { text: "Filters", link: "/api/filters" },
          { text: "Updates", link: "/api/updates" },
          { text: "Migrations", link: "/api/migrations" },
          { text: "Encryption", link: "/api/encryption" },
          { text: "Live Queries", link: "/api/live-queries" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/thinkgrid-labs/taladb" },
      { icon: "heart", link: "https://github.com/sponsors/thinkgrid-labs" },
    ],

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 ThinkGrid Labs",
    },

    editLink: {
      pattern: "https://github.com/thinkgrid-labs/taladb/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    search: {
      provider: "local",
    },
  },

  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark",
    },
  },
});
