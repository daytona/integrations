/** Canonical wire names; TypeScript overrides use `type_` for the wire member `type`. */
export const COMPUTER_MEMBERS = [
  "key", "hold_key", "type", "cursor_position", "mouse_move", "left_mouse_down",
  "left_mouse_up", "left_click", "left_click_drag", "right_click", "middle_click",
  "double_click", "triple_click", "scroll", "wait", "screenshot", "zoom",
] as const;

/** Canonical browser wire names in SDK declaration order. */
export const BROWSER_MEMBERS = [
  "navigate", "screenshot", "zoom", "left_click", "right_click", "middle_click",
  "double_click", "triple_click", "hover", "left_click_drag", "left_mouse_down",
  "left_mouse_up", "mouse_move", "scroll", "scroll_to", "type", "key", "hold_key",
  "form_input", "read_page", "find", "get_page_text", "wait", "file_upload",
  "read_console", "read_network", "javascript_exec", "new_tab", "list_tabs",
  "switch_tab", "close_tab",
] as const;
