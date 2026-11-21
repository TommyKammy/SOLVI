export function Icon({ name }) {
  return (
    <svg className="editor-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <use href={'/editor-icons.svg#' + name} />
    </svg>
  );
}

export function ActionButton({ icon, label, showLabel = false, type = 'button', ...props }) {
  return (
    <button
      type={type}
      title={label}
      className={showLabel ? 'labeled-action' : 'icon-action'}
      {...props}
    >
      <Icon name={icon} />
      <span className={showLabel ? undefined : 'visually-hidden'}>{label}</span>
    </button>
  );
}
