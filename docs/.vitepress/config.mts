import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'TalaDB',
  description: 'Local-first document database. Zero cloud. Zero GC. Zero compromise.',
  base: '/taladb/',

  head: [
    ['link', { rel: 'icon', href: '/taladb/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#f97316' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'TalaDB',

    nav: [
      { text: 'Introduction', link: '/introduction' },
      { text: 'Guides', link: '/guide/web' },
      { text: 'API Reference', link: '/api/collection' },
      { text: 'Roadmap', link: '/roadmap' },
      {
        text: 'v0.1.0',
        items: [
          { text: 'Changelog', link: 'https://github.com/thinkgrid-labs/taladb/releases' },
          { text: 'Contributing', link: 'https://github.com/thinkgrid-labs/taladb/blob/main/CONTRIBUTING.md' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/introduction' },
          { text: 'Core Concepts', link: '/concepts' },
          { text: 'Features', link: '/features' },
        ],
      },
      {
        text: 'Platform Guides',
        items: [
          { text: 'Web (Browser / WASM)', link: '/guide/web' },
          { text: 'Node.js', link: '/guide/node' },
          { text: 'React Native', link: '/guide/react-native' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Collection', link: '/api/collection' },
          { text: 'Filters', link: '/api/filters' },
          { text: 'Updates', link: '/api/updates' },
          { text: 'Migrations', link: '/api/migrations' },
          { text: 'Encryption', link: '/api/encryption' },
          { text: 'Live Queries', link: '/api/live-queries' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/thinkgrid-labs/taladb' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025-present thinkgrid-labs',
    },

    editLink: {
      pattern: 'https://github.com/thinkgrid-labs/taladb/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },
  },

  markdown: {
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },
})
