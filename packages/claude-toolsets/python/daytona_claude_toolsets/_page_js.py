"""The JavaScript the browser driver runs in each page.

It runs in an isolated world (a JavaScript context of the driver's own, sharing the DOM with the page
but not its globals), so a page can neither see nor rewrite the element references, and page
scripts that replace built-ins do not change what the driver reads.

`TOOLKIT` installs `globalThis.__dt` once per document; the other snippets call it.

Why it is JavaScript and not Python. Every entry point here answers a question only the live
document can answer, and each is one CDP round trip rather than thousands. A role, an accessible
name and whether an element is visible come from computed style, layout boxes and the live
accessibility-relevant attributes of a node that scripts keep changing; `ref_N` is an identity
handle into that same live tree, and it has to stay valid between the read and the click, which
means it cannot be a snapshot shipped to Python. `center`, `scrollTo`, `setValue` and `fileInput`
each need the element itself — its box after layout, its native value setter, its file-input
node. Parsing an HTML copy in Python would answer about a document that no longer exists and
would be wrong for exactly the pages a model gets stuck on. What does not need the page is not
here: ranking the candidates `candidates()` returns, URL handling and all the text bounding live
in `_text.py`, and the refusal codes this file returns are turned into the model's wording in
`browser.py` (a test pins the two lists against each other).
"""

from __future__ import annotations

import json

TOOLKIT = r"""
(() => {
  if (globalThis.__dt) return;
  const byRef = new Map();       // "ref_7" -> WeakRef(element)
  const byElement = new WeakMap(); // element -> "ref_7"
  let next = 1;
  const MAX = 50000;

  const refOf = (el) => {
    let ref = byElement.get(el);
    if (!ref) { ref = 'ref_' + next++; byElement.set(el, ref); byRef.set(ref, new WeakRef(el)); }
    return ref;
  };
  const deref = (ref) => {
    const weak = byRef.get(ref);
    const el = weak && weak.deref();
    return el && el.isConnected ? el : null;
  };
  const squash = (text, limit) => {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
  };
  const quote = (s) => JSON.stringify(s);

  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox',
    radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'button',
  };
  const TAG_ROLES = {
    BUTTON: 'button', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'img', NAV: 'navigation', MAIN: 'main',
    ASIDE: 'complementary', FORM: 'form', ARTICLE: 'article', UL: 'list', OL: 'list',
    LI: 'listitem', TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', P: 'paragraph',
    DIALOG: 'dialog', DETAILS: 'group', SUMMARY: 'button', OPTION: 'option', IFRAME: 'iframe',
    VIDEO: 'video', AUDIO: 'audio', PROGRESS: 'progressbar', HR: 'separator', HEADER: 'banner',
    FOOTER: 'contentinfo', BLOCKQUOTE: 'blockquote', PRE: 'code',
  };
  const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio',
    'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'option',
    'menuitemcheckbox', 'menuitemradio', 'treeitem', 'clickable']);
  const NAMED_FROM_CONTENT = new Set(['link', 'button', 'heading', 'tab', 'menuitem', 'option',
    'cell', 'columnheader', 'listitem', 'paragraph', 'treeitem', 'clickable',
    'blockquote', 'code']);

  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      return INPUT_ROLES[type] || 'textbox';
    }
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'SECTION') return el.hasAttribute('aria-label') ? 'region' : null;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) return 'clickable';
    return null;
  };
  const CONTROLS = new Set(['SELECT', 'TEXTAREA', 'INPUT', 'BUTTON', 'OPTION']);
  // A label's own words, without the text of the controls inside it (a select's options).
  const ownText = (node) => {
    let text = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1 && !CONTROLS.has(child.tagName)) text += ' ' + ownText(child);
    }
    return text;
  };
  const labelText = (el) => {
    if (el.labels && el.labels.length) return Array.from(el.labels, ownText).join(' ');
    return '';
  };
  const nameOf = (el, role) => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = by.split(/\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? target.innerText || target.textContent : '';
      }).join(' ');
      if (text.trim()) return squash(text, 150);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return squash(aria, 150);
    const tag = el.tagName;
    if (tag === 'IMG') return squash(el.getAttribute('alt') || el.getAttribute('title'), 150);
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return squash(el.value || type, 150);
      return squash(labelText(el) || el.getAttribute('placeholder') || el.getAttribute('title')
        || el.getAttribute('name'), 150);
    }
    if (NAMED_FROM_CONTENT.has(role)) return squash(el.innerText || el.textContent, role === 'paragraph' ? 300 : 150);
    return squash(el.getAttribute('title'), 150);
  };
  const extrasOf = (el, role) => {
    const out = [];
    const tag = el.tagName;
    if (role === 'heading' && /^H[1-6]$/.test(tag)) out.push('level=' + tag[1]);
    if (role === 'link') out.push('href=' + quote(squash(el.getAttribute('href'), 200)));
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') out.push(el.checked ? 'checked' : 'unchecked');
      else if (type === 'file') out.push('type=file');
      else if (type === 'password') out.push('type=password');
      else if (!['button', 'submit', 'reset', 'image'].includes(type)) out.push('value=' + quote(squash(el.value, 200)));
    }
    if (tag === 'TEXTAREA') out.push('value=' + quote(squash(el.value, 200)));
    if (tag === 'SELECT') {
      const chosen = Array.from(el.selectedOptions || [], (o) => squash(o.text, 80));
      out.push('selected=' + quote(chosen.join(', ')));
      out.push('options=' + quote(Array.from(el.options, (o) => squash(o.text, 40)).slice(0, 20).join(' | ')));
    }
    if (el.getAttribute('aria-expanded')) out.push('expanded=' + el.getAttribute('aria-expanded'));
    if (el.getAttribute('aria-checked')) out.push('checked=' + el.getAttribute('aria-checked'));
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    return out.length ? ' ' + out.join(' ') : '';
  };
  const hidden = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
  };
  const onScreen = (el) => {
    const rects = el.getClientRects();
    for (const r of rects) {
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) return true;
    }
    return false;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'svg', 'SVG']);

  // Walks the DOM from `root`, emitting one line per element that has a role and a `text` line per
  // run of loose text. Elements without a role are transparent: their children appear in their place.
  const walk = (root, opts, sink) => {
    const visit = (el, depth) => {
      if (sink.full || SKIP.has(el.tagName) || hidden(el)) return;
      const role = roleOf(el);
      let childDepth = depth;
      if (role) {
        const interactive = INTERACTIVE.has(role);
        const shown = opts.all || onScreen(el);
        if (shown && (!opts.interactive || interactive) && depth < opts.depth) {
          const name = nameOf(el, role);
          sink.emit(depth, role + (name ? ' ' + quote(name) : '') + ' [' + refOf(el) + ']' + extrasOf(el, role), el, role, name);
          childDepth = depth + 1;
          if (NAMED_FROM_CONTENT.has(role) && role !== 'listitem' && role !== 'cell') {
            // its text is its name; only elements with roles inside it are listed
            for (const child of el.children) visitRolesOnly(child, childDepth);
            return;
          }
        }
      }
      for (const node of el.childNodes) {
        if (node.nodeType === 1) visit(node, childDepth);
        else if (node.nodeType === 3 && !opts.interactive && depth < opts.depth) {
          const text = squash(node.textContent, 300);
          if (text && (opts.all || (node.parentElement && onScreen(node.parentElement)))) sink.emit(childDepth, 'text ' + quote(text), null, 'text', text);
        }
      }
      if (el.shadowRoot) for (const child of el.shadowRoot.children) visit(child, childDepth);
    };
    const visitRolesOnly = (el, depth) => {
      if (sink.full || SKIP.has(el.tagName) || hidden(el)) return;
      if (roleOf(el)) { visit(el, depth); return; }
      for (const child of el.children) visitRolesOnly(child, depth);
    };
    visit(root, 0);
  };

  const lines = () => {
    const out = [];
    let size = 0;
    const sink = {
      full: false,
      emit(depth, line) {
        if (this.full) return;
        const text = '  '.repeat(depth) + line;
        if (size + text.length + 1 > MAX) { this.full = true; return; }
        size += text.length + 1;
        out.push(text);
      },
    };
    return { out, sink };
  };

  globalThis.__dt = {
    deref,
    readPage(opts) {
      const root = opts.ref ? deref(opts.ref) : (document.body || document.documentElement);
      if (!root) return { error: 'stale' };
      const { out, sink } = lines();
      walk(root, opts, sink);
      if (sink.full) out.push('[Output truncated at 50,000 characters; narrow it with ref or a smaller depth.]');
      return { text: out.join('\n') };
    },
    candidates() {
      const found = [];
      const sink = {
        full: false,
        emit(depth, line, el, role, name) {
          if (!el) return;
          if (found.length >= 5000) { this.full = true; return; }
          const attrs = ['placeholder', 'aria-label', 'title', 'name', 'id', 'type', 'alt', 'href', 'value', 'class']
            .map((a) => el.getAttribute(a) || '').join(' ');
          found.push({ line, role, name, attrs: squash(attrs, 400), interactive: INTERACTIVE.has(role), visible: onScreen(el) });
        },
      };
      walk(document.body || document.documentElement, { all: true, interactive: false, depth: 1000 }, sink);
      return found;
    },
    pageText() {
      const body = document.body || document.documentElement;
      if (!body) return '';
      let root = body;
      for (const selector of ['article', 'main', '[role=main]']) {
        const el = document.querySelector(selector);
        if (el && (el.innerText || '').trim().length > 200) { root = el; break; }
      }
      const text = (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      return text.length > MAX ? text.slice(0, MAX) + '\n[Text truncated at 50,000 characters.]' : text;
    },
    center(ref) {
      const el = deref(ref);
      if (!el) return { error: 'stale' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { error: 'invisible' };
      const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      return { x, y };
    },
    scrollTo(ref) {
      const el = deref(ref);
      if (!el) return { error: 'stale' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return {};
    },
    setValue(ref, value) {
      const el = deref(ref);
      if (!el) return { error: 'stale' };
      const fire = () => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const tag = el.tagName;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'SELECT') {
        const wanted = String(value);
        const options = Array.from(el.options);
        const option = options.find((o) => o.value === wanted)
          || options.find((o) => o.text.trim().toLowerCase() === wanted.trim().toLowerCase());
        if (!option) return { error: 'no-option' };
        el.value = option.value;
        option.selected = true;
        fire();
        return {};
      }
      if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
        if (typeof value !== 'boolean') return { error: 'want-boolean' };
        // Clicking a selected radio leaves it selected, so `false` would report a change that did
        // not happen. Only choosing another button in the group clears this one. A radio that is
        // already clear is the state `false` asks for, so that call has nothing to refuse.
        if (type === 'radio' && value === false && el.checked) return { error: 'radio-off' };
        if (el.checked === value) return {};
        // A click is the only way to change one of these, and a disabled control ignores it, so
        // clicking would report a change that did not happen. `:disabled` and not `.disabled`:
        // an ancestor <fieldset disabled> disables the control without setting its attribute.
        // The branches below write the value directly, which a disabled field does take.
        if (el.matches(':disabled')) return { error: 'disabled' };
        el.click();
        return {};
      }
      if (typeof value === 'boolean') return { error: 'not-checkable' };
      if (tag === 'INPUT' && type === 'file') return { error: 'file-input' };
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        el.focus();
        const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
        fire();
        return {};
      }
      if (el.isContentEditable) {
        el.focus();
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, String(value));
        return {};
      }
      return { error: 'not-a-field' };
    },
    fileInput(ref) {
      const el = deref(ref);
      if (!el) return { error: 'stale' };
      if (el.tagName !== 'INPUT' || (el.getAttribute('type') || '').toLowerCase() !== 'file') return { error: 'not-file' };
      return el;
    },
  };
})()
"""


def call(function: str, *args: object) -> str:
    """An expression that runs `globalThis.__dt.<function>(*args)` in a world `TOOLKIT` ran in."""
    encoded = ", ".join(json.dumps(arg) for arg in args)
    return f"globalThis.__dt.{function}({encoded})"
