<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import "./HomeView.css";
import { login, register } from "../lib/api";
import { useAuthState } from "../lib/auth";

const REMEMBERED_EMAIL_KEY = "agent-char-remembered-email";

const router = useRouter();
const auth = useAuthState();
const mode = ref<"login" | "register">("login");
const username = ref("");
const email = ref("");
const password = ref("");
const rememberAccount = ref(false);
const pending = ref(false);
const errorMessage = ref("");

const title = computed(() =>
    mode.value === "login" ? "Welcome back to Agent Char" : "Create your secure AI workspace",
);

async function submit() {
    pending.value = true;
    errorMessage.value = "";

    try {
        if (mode.value === "login") {
            await login({
                email: email.value,
                password: password.value,
            });
        } else {
            await register({
                username: username.value,
                email: email.value,
                password: password.value,
            });
        }

        if (rememberAccount.value) {
            window.localStorage.setItem(REMEMBERED_EMAIL_KEY, email.value.trim());
        } else {
            window.localStorage.removeItem(REMEMBERED_EMAIL_KEY);
        }

        await router.push("/chat");
    } catch (error) {
        errorMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
        pending.value = false;
    }
}

async function goToChat() {
    await router.push("/chat");
}

onMounted(() => {
    const rememberedEmail = window.localStorage.getItem(REMEMBERED_EMAIL_KEY);
    if (!rememberedEmail) {
        return;
    }

    email.value = rememberedEmail;
    rememberAccount.value = true;
});

watch(rememberAccount, (enabled) => {
    if (enabled) {
        return;
    }

    window.localStorage.removeItem(REMEMBERED_EMAIL_KEY);
});
</script>

<template>
  <main class="landing-shell">
    <section class="landing-panel hero-panel">
      <div class="eyebrow">Secure AI Dialogue Lab</div>
      <div class="hero-grid">
        <div>
          <h1 class="landing-title">
            Human-first access,
            <span>defense-ready rendering.</span>
          </h1>
          <p class="landing-lead">
            这版首页把安全架构直接摆在台面上：短期 access token 只放内存，refresh token 走
            <code>HttpOnly Cookie</code>；进入对话页后，AI 回复渲染会经过
            <code>DOMPurify</code> 过滤，先挡掉 XSS 风险，再谈体验。
          </p>
          <ul class="security-list">
            <li>Access Token in memory only</li>
            <li>Refresh Token in HttpOnly Cookie</li>
            <li>MySQL stores users, sessions, conversations, messages</li>
            <li>Assistant HTML sanitized with DOMPurify before render</li>
          </ul>
        </div>

        <aside class="landing-card">
          <div class="section-tag">Identity Gateway</div>
          <h2>{{ title }}</h2>
          <p>
            {{ mode === "login"
              ? "登录成功后会直接跳转到 AI 对话页。"
              : "注册完成后会立即签发双 Token 并跳转到 AI 对话页。" }}
          </p>

          <form class="auth-form" @submit.prevent="submit">
            <label v-if="mode === 'register'" class="field">
              <span>Username</span>
              <input v-model="username" type="text" placeholder="Ada Lovelace" />
            </label>

            <label class="field">
              <span>Email</span>
              <input v-model="email" type="email" placeholder="you@example.com" />
            </label>

            <label class="field">
              <span>Password</span>
              <input v-model="password" type="password" placeholder="At least 6 characters" />
            </label>

            <label v-if="mode === 'login'" class="remember-row">
              <input v-model="rememberAccount" type="checkbox" />
              <span>Remember this email on this device</span>
            </label>

            <p v-if="errorMessage" class="form-error">{{ errorMessage }}</p>

            <div class="hero-actions">
              <button class="primary-button" type="submit" :disabled="pending">
                {{ pending ? "Working..." : mode === "login" ? "Login and enter chat" : "Register and enter chat" }}
              </button>
              <button
                class="secondary-button"
                type="button"
                @click="mode = mode === 'login' ? 'register' : 'login'"
              >
                {{ mode === "login" ? "Need an account?" : "Already have an account?" }}
              </button>
            </div>
          </form>

          <button
            v-if="auth.isAuthenticated.value"
            class="ghost-link"
            type="button"
            @click="goToChat"
          >
            Continue to chat
          </button>
        </aside>
      </div>
    </section>
  </main>
</template>
