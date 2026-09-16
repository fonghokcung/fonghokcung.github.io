<script setup>
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <header>
    <div class="wrapper">
      <nav>
        <RouterLink to="/">Home</RouterLink>
        <RouterLink to="/dtwin">DTwin</RouterLink>
      </nav>
    </div>
  </header>

  <RouterView class="tag__RouterView" />
</template>

<style scoped>
header {
  max-height: 100vh;
}
.tag__RouterView {
  border: 1px solid var(--color-primary);
}
</style>
