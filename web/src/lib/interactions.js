export function isInteractive(event) {
  return Boolean(event.target.closest('button, input, select, textarea, a, label, .custom-select, .row-menu'));
}
