<script>
  import { openBuilder } from './controller';
</script>

<!--
  Just the toolbar button: mount-toolbar.js attaches this component's own
  container next to Actual's own "Add new widget" button. The builder itself is
  a full-screen dialog (BuilderModal.svelte) that controller.js mounts on
  <body>.
-->
<div class="actualmint-widget-builder">
  <button type="button" class="actualmint-wb-toggle" onclick={() => openBuilder()}>Widget builder</button>
</div>

<style>
  .actualmint-widget-builder {
    /* A normal inline sibling of Actual's own "Add new widget" button, not a
       fixed overlay: see mount-toolbar.js for why. */
    display: inline-block;
    margin-left: 0.5rem;
    font-family: inherit;
    font-size: 0.9rem;
  }

  /* Styled as a plain secondary toolbar button (matching Actual's own
     "Edit dashboard" button next to it). */
  .actualmint-wb-toggle {
    cursor: pointer;
    padding: 0.5rem 1rem;
    border-radius: 0.25rem;
    border: 1px solid var(--color-buttonNormalBorder, #ccc);
    background: var(--color-buttonNormalBackground, #fff);
    color: var(--color-buttonNormalText, #222);
    font: inherit;
  }
</style>
