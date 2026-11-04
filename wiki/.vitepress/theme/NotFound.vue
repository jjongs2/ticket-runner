<script setup lang="ts">
import { withBase } from "vitepress";
</script>

<!-- The wiki's own 404. With no root locale, the theme's would link the neutral home
     only, so this one links each language's home. -->
<template>
  <div class="NotFound">
    <p class="code">404</p>
    <h1 class="title">PAGE NOT FOUND</h1>
    <p class="lead">No page of the wiki is at this address.</p>
    <div class="action">
      <a class="link" :href="withBase('/en/')" lang="en">English home</a>
      <a class="link" :href="withBase('/ko/')" lang="ko">한국어 홈</a>
    </div>
  </div>
</template>

<style scoped>
.NotFound {
  padding: 64px 24px 96px;
  text-align: center;
}

@media (min-width: 768px) {
  .NotFound {
    padding: 96px 32px 168px;
  }
}

.code {
  line-height: 64px;
  font-size: 64px;
  font-weight: 600;
}

.title {
  padding-top: 12px;
  letter-spacing: 2px;
  line-height: 20px;
  font-size: 20px;
  font-weight: 700;
}

.lead {
  margin: 24px auto 0;
  color: var(--vp-c-text-2);
}

.action {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding-top: 24px;
}

.link {
  display: inline-block;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 16px;
  padding: 3px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  transition: border-color 0.25s, color 0.25s;
}

.link:hover {
  border-color: var(--vp-c-brand-2);
  color: var(--vp-c-brand-2);
}
</style>
