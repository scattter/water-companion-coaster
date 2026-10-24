if (import.meta.env.TAURI_ENV_PLATFORM === 'android') {
  void import('./mobile/main').then(module => module.mountMobile());
} else {
  void Promise.all([import('vue'), import('./App.vue'), import('./style.css')]).then(([{ createApp }, { default: App }]) => {
    createApp(App).mount('#app');
  });
}
