import { createApp } from "vue";
import VueVirtualScroller from "vue-virtual-scroller";
import App from "./App.vue";
import router from "./router";
import "vue-virtual-scroller/index.css";
import "./style.css";

createApp(App)
    .use(VueVirtualScroller)
    .use(router)
    .mount("#app");
