import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

document.documentElement.classList.toggle('is-embedded', new URLSearchParams(window.location.search).get('embed') === '1')

createApp(App).mount('#app')
