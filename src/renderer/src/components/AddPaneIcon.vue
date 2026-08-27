<template>
  <!-- A terminal whose bottom-right corner is left open for the plus, so the
       two shapes read as one mark rather than as two overlapping icons.

       Drawn for the size it is actually used at. The sibling buttons render
       their 16-unit artwork at 11px, and at that scale a full terminal frame
       plus a prompt plus a plus is too much: the prompt closes up into a blob.
       So the frame stops short, the prompt is drawn wide and shallow (2.5
       units per stroke instead of the usual 1.75), and the plus is given a
       full 5 units — the three elements each stay above roughly 1.5px on
       screen, which is where a 1.4-weight stroke still reads. -->
  <svg class="add-pane-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M14 8.6V4.25A1.75 1.75 0 0 0 12.25 2.5h-8.5A1.75 1.75 0 0 0 2 4.25v7.5A1.75 1.75 0 0 0 3.75 13.5H8.6" />
    <path d="M4.9 5.9 7.4 8.4 4.9 10.9" />
    <path d="M12.25 9.75v5M9.75 12.25h5" />
  </svg>
</template>

<style scoped>
.add-pane-icon {
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
