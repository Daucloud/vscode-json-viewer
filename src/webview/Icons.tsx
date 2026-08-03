import React from 'react';

export type IconName =
  | 'braces'
  | 'check'
  | 'chevronDown'
  | 'chevronRight'
  | 'close'
  | 'collapse'
  | 'copy'
  | 'error'
  | 'expand'
  | 'expandAll'
  | 'external'
  | 'fileCode'
  | 'filter'
  | 'info'
  | 'maximize'
  | 'plus'
  | 'refresh'
  | 'reset'
  | 'restore'
  | 'save'
  | 'saveAs'
  | 'search'
  | 'sort'
  | 'sparkle'
  | 'subtree'
  | 'table'
  | 'trash'
  | 'undo'
  | 'redo'
  | 'warning';

const drawings: Record<IconName, React.ReactNode> = {
  braces: <><path d="M6.5 2.5H5.2c-1 0-1.7.7-1.7 1.7v2.1c0 .9-.5 1.5-1.4 1.7.9.2 1.4.8 1.4 1.7v2.1c0 1 .7 1.7 1.7 1.7h1.3"/><path d="M9.5 2.5h1.3c1 0 1.7.7 1.7 1.7v2.1c0 .9.5 1.5 1.4 1.7-.9.2-1.4.8-1.4 1.7v2.1c0 1-.7 1.7-1.7 1.7H9.5"/></>,
  check: <path d="m3 8.3 3.1 3.1L13.2 4.5"/>,
  chevronDown: <path d="m3.5 6 4.5 4.5L12.5 6"/>,
  chevronRight: <path d="m6 3.5 4.5 4.5L6 12.5"/>,
  close: <><path d="m4 4 8 8"/><path d="m12 4-8 8"/></>,
  collapse: <><path d="M4 2.5v4h4"/><path d="m4 6.5 3-3"/><path d="M12 13.5v-4H8"/><path d="m12 9.5-3 3"/></>,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.4"/><path d="M10.5 5.5v-2c0-.6-.4-1-1-1h-7v7c0 .6.4 1 1 1h2"/></>,
  error: <><circle cx="8" cy="8" r="5.6"/><path d="M8 4.7v3.8"/><path d="M8 11.3h.01"/></>,
  expand: <><path d="M7.5 2.5h-5v5"/><path d="m2.5 7.5 4-4"/><path d="M8.5 13.5h5v-5"/><path d="m13.5 8.5-4 4"/></>,
  expandAll: <><path d="M2.5 6V2.5H6"/><path d="m2.8 2.8 3 3"/><path d="M9.5 2.5h4V6"/><path d="m13.2 2.8-3 3"/><path d="M2.5 10v3.5H6"/><path d="m2.8 13.2 3-3"/><path d="M9.5 13.5h4V10"/><path d="m13.2 13.2-3-3"/></>,
  external: <><path d="M13 8.5v4a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M9 2.5h4.5V7"/><path d="m13.2 2.8-6 6"/></>,
  fileCode: <><path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/><path d="m7 8-1.5 1.5L7 11"/><path d="m9 8 1.5 1.5L9 11"/></>,
  filter: <path d="M2.5 3h11L9.3 8v4.2l-2.6 1.3V8z"/>,
  info: <><circle cx="8" cy="8" r="5.6"/><path d="M8 7.1v4"/><path d="M8 4.7h.01"/></>,
  maximize: <><path d="M2.5 6V2.5H6"/><path d="m2.8 2.8 3.6 3.6"/><path d="M10 2.5h3.5V6"/><path d="m13.2 2.8-3.6 3.6"/><path d="M2.5 10v3.5H6"/><path d="m2.8 13.2 3.6-3.6"/><path d="M10 13.5h3.5V10"/><path d="m13.2 13.2-3.6-3.6"/></>,
  plus: <><path d="M8 3v10"/><path d="M3 8h10"/></>,
  refresh: <><path d="M13.2 6.2A5.4 5.4 0 0 0 3.6 4.4L2.5 5.7"/><path d="M2.5 2.8v2.9h2.9"/><path d="M2.8 9.8a5.4 5.4 0 0 0 9.6 1.8l1.1-1.3"/><path d="M13.5 13.2v-2.9h-2.9"/></>,
  reset: <><path d="M3.3 5.4A5.3 5.3 0 1 1 3 10"/><path d="M3.3 2.6v2.8h2.8"/></>,
  restore: <><path d="M6 5.5V2.8h7.2V10h-2.7"/><path d="M2.8 6h7.2v7.2H2.8z"/></>,
  save: <><path d="M3 2.5h8.5l1.5 1.6v9.4H3z"/><path d="M5.3 2.5v4h5v-4"/><path d="M5.2 13.5V9h5.6v4.5"/></>,
  saveAs: <><path d="M2.8 2.5h7.8L12 4v3.2"/><path d="M2.8 2.5v11h4"/><path d="M5 2.5v3.7h4.6V2.5"/><path d="m9 12.7 4-4"/><path d="M10.2 8.7H13v2.8"/></>,
  search: <><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/></>,
  sort: <><path d="M5 3v10"/><path d="m2.8 5.2 2.2-2.2 2.2 2.2"/><path d="M11 13V3"/><path d="m8.8 10.8 2.2 2.2 2.2-2.2"/></>,
  sparkle: <><path d="M8 1.8c.5 3.1 2.1 4.7 5.2 5.2-3.1.5-4.7 2.1-5.2 5.2C7.5 9.1 5.9 7.5 2.8 7 5.9 6.5 7.5 4.9 8 1.8Z"/><path d="M12.7 11.5c.2 1 .8 1.6 1.8 1.8-1 .2-1.6.8-1.8 1.8-.2-1-.8-1.6-1.8-1.8 1-.2 1.6-.8 1.8-1.8Z"/></>,
  subtree: <><path d="M3 2.5v7.8c0 1 .8 1.7 1.7 1.7H7"/><path d="M3 6.5h4"/><path d="m6.5 4.5 2 2-2 2"/><path d="m6.5 10 2 2-2 2"/><path d="M10.5 6.5h2.8"/><path d="M10.5 12h2.8"/></>,
  table: <><rect x="2.3" y="3" width="11.4" height="10" rx="1"/><path d="M2.3 6.3h11.4"/><path d="M6.1 3v10"/></>,
  trash: <><path d="M3.5 4.5h9"/><path d="M6 4.5V2.8h4v1.7"/><path d="m4.7 4.5.7 9h5.2l.7-9"/><path d="M7 7v4"/><path d="M9 7v4"/></>,
  undo: <><path d="M5.5 4H2.7v-2.8"/><path d="M2.9 3.8A6 6 0 0 1 13 8.2a5.4 5.4 0 0 1-5.5 5.1"/></>,
  redo: <><path d="M10.5 4h2.8v-2.8"/><path d="M13.1 3.8A6 6 0 0 0 3 8.2a5.4 5.4 0 0 0 5.5 5.1"/></>,
  warning: <><path d="M7.1 2.6 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z"/><path d="M8 6v3.2"/><path d="M8 11.5h.01"/></>,
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): React.JSX.Element {
  return <svg
    className={className ? `ui-icon ${className}` : 'ui-icon'}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >{drawings[name]}</svg>;
}
