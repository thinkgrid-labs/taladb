import DefaultTheme from "vitepress/theme";
import "./custom.css";

import HomeHero from "./components/HomeHero.vue";
import HomeSocialProof from "./components/HomeSocialProof.vue";
import HomeFeatures from "./components/HomeFeatures.vue";
import HomeComparison from "./components/HomeComparison.vue";
import HomeUseCases from "./components/HomeUseCases.vue";
import HomeQuickStart from "./components/HomeQuickStart.vue";
import HomeCTA from "./components/HomeCTA.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: import("vue").App }) {
    app.component("HomeHero", HomeHero);
    app.component("HomeSocialProof", HomeSocialProof);
    app.component("HomeFeatures", HomeFeatures);
    app.component("HomeComparison", HomeComparison);
    app.component("HomeUseCases", HomeUseCases);
    app.component("HomeQuickStart", HomeQuickStart);
    app.component("HomeCTA", HomeCTA);
  },
};
