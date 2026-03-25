import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // Inject the banner SVG before the name/text block in the hero
      'home-hero-info-before': () =>
        h('img', {
          src: '/taladb/taladb-banner.svg',
          alt: 'TalaDB — Local-first document database',
          class: 'hero-logo-banner',
        }),
    }),
}
