import { createApp } from "vue";
import VueVirtualScroller from "vue-virtual-scroller";
import App from "./App.vue";
import "vue-virtual-scroller/index.css";
import "./style.css";

createApp(App)
    .use(VueVirtualScroller)
    .mount("#app");
