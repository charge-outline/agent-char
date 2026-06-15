import { createRouter, createWebHistory } from "vue-router";
import { ensureAuthenticated } from "./lib/api";

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: "/",
            name: "home",
            component: () => import("./views/HomeView.vue"),
        },
        {
            path: "/chat",
            name: "chat",
            component: () => import("./views/ChatView.vue"),
            meta: {
                requiresAuth: true,
            },
        },
    ],
});

router.beforeEach(async (to) => {
    if (!to.meta.requiresAuth) {
        return true;
    }

    const ok = await ensureAuthenticated();
    if (!ok) {
        return {
            name: "home",
        };
    }

    return true;
});

export default router;
