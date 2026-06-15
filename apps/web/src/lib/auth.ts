import { computed, reactive } from "vue";

export type AuthUser = {
    id: number;
    username: string;
    email: string;
};

type AuthState = {
    accessToken: string | null;
    user: AuthUser | null;
    hydrated: boolean;
};

const state = reactive<AuthState>({
    accessToken: null,
    user: null,
    hydrated: false,
});

export function useAuthState() {
    const isAuthenticated = computed(() => !!state.accessToken && !!state.user);

    function setSession(payload: { accessToken: string; user: AuthUser }) {
        state.accessToken = payload.accessToken;
        state.user = payload.user;
        state.hydrated = true;
    }

    function clearSession() {
        state.accessToken = null;
        state.user = null;
        state.hydrated = true;
    }

    function markHydrated() {
        state.hydrated = true;
    }

    return {
        state,
        isAuthenticated,
        setSession,
        clearSession,
        markHydrated,
    };
}
