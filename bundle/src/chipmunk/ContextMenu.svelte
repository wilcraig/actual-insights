<script>
  import { onMount } from 'svelte';

  // A right-click menu: `items` is [{ label, run, disabled, danger, separator }].
  // Closes on Escape, a click anywhere else, scrolling or resizing; arrows move.
  let { x, y, items, onClose, label = 'Actions' } = $props();
  let menu;
  let index = $state(-1);
  let left = $state(x);
  let top = $state(y);

  const enabled = () => items.map((it, i) => (it.separator || it.disabled ? -1 : i)).filter((i) => i >= 0);

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const list = enabled();
      if (list.length === 0) return;
      const at = list.indexOf(index);
      const next = event.key === 'ArrowDown' ? list[(at + 1) % list.length] : list[(at - 1 + list.length) % list.length];
      index = at === -1 && event.key === 'ArrowUp' ? list[list.length - 1] : next;
      menu.querySelectorAll('button')[index]?.focus();
    }
  }

  function choose(item) {
    if (item.disabled) return;
    onClose();
    item.run?.();
  }

  onMount(() => {
    // Keep it on screen.
    const r = menu.getBoundingClientRect();
    left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    const away = (e) => {
      if (!menu.contains(e.target)) onClose();
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('contextmenu', away, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    menu.querySelector('button:not([disabled])')?.focus();
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('contextmenu', away, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  });
</script>

<div class="cm-ctx" role="menu" aria-label={label} bind:this={menu} style="left:{left}px;top:{top}px" oncontextmenu={(e) => e.preventDefault()}>
  {#each items as item, i (i)}
    {#if item.separator}
      <hr />
    {:else}
      <button type="button" role="menuitem" class:danger={item.danger} disabled={item.disabled} onclick={() => choose(item)}>{item.label}</button>
    {/if}
  {/each}
</div>

<style>
  .cm-ctx { position: fixed; z-index: 2147483300; min-width: 200px; padding: 5px; border-radius: 10px; background: var(--cm-bg, Canvas); color: var(--cm-fg, CanvasText); border: 1px solid var(--cm-line, rgba(128, 128, 128, 0.35)); box-shadow: 0 10px 34px rgba(0, 0, 0, 0.4); display: flex; flex-direction: column; }
  button { border: 0; background: transparent; color: inherit; font: 14px/1.3 system-ui, sans-serif; text-align: left; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
  button:hover:not([disabled]), button:focus-visible { background: color-mix(in srgb, currentColor 12%, transparent); outline: none; }
  button[disabled] { opacity: 0.4; cursor: default; }
  .danger { color: #dc2626; }
  hr { border: 0; border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); margin: 4px 2px; width: 100%; }
</style>
