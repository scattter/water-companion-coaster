<script setup lang="ts">
import { characters, framePath, frameStyle } from './display';
import type { Character } from './types';

defineProps<{ modelValue: Character; disabled?: boolean }>();
defineEmits<{ 'update:modelValue': [value: Character] }>();
</script>

<template>
  <fieldset class="character-picker" :disabled="disabled">
    <legend>陪伴形象</legend>
    <div class="character-options">
      <button v-for="character in characters" :key="character.id" type="button" class="character-option" :aria-pressed="modelValue === character.id" @click="$emit('update:modelValue', character.id)">
        <img :src="framePath('idle', 0, character.id)" :style="frameStyle(character.id)" alt="" draggable="false" />
        <span>{{ character.name }}</span>
      </button>
    </div>
    <p>水豚支持状态动画，其他形象为静态陪伴。</p>
  </fieldset>
</template>

<style scoped>
.character-picker { border: 0; margin: 16px 0 0; padding: 0; min-width: 0; }
.character-picker legend { padding: 0 0 8px; font-size: 13px; font-weight: 650; color: var(--text, #263d35); }
.character-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.character-option { min-width: 0; padding: 5px; border: 1px solid var(--line, #dce4da); border-radius: 8px; background: var(--input, #fff); color: var(--text, #263d35); font: inherit; font-size: 12px; cursor: pointer; }
.character-option[aria-pressed="true"] { border-color: var(--green, #39735c); background: var(--soft-green, #e8efe4); box-shadow: inset 0 0 0 1px var(--green, #39735c); }
.character-option:focus-visible { outline: 3px solid #81b7a0; outline-offset: 2px; }
.character-option:disabled { cursor: default; opacity: .55; }
.character-option img { display: block; width: 100%; aspect-ratio: 2 / 1; object-fit: contain; image-rendering: pixelated; pointer-events: none; }
.character-option span { display: block; margin-top: 3px; }
.character-picker p { margin: 8px 0 0; color: var(--muted, #728279); font-size: 11px; line-height: 1.6; }
</style>
