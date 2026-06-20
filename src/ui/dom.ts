// Minimal typed DOM helper — no framework, keeps the runtime tiny.

type Child = Node | string | null | undefined | false;

interface Attrs {
  class?: string;
  id?: string;
  type?: string;
  title?: string;
  value?: string | number;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  text?: string;
  style?: string;
  dataset?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, EventListener>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  if (attrs.id) node.id = attrs.id;
  if (attrs.title) node.title = attrs.title;
  if (attrs.style) node.setAttribute('style', attrs.style);
  if (attrs.text != null) node.textContent = attrs.text;
  if (attrs.type && 'type' in node) (node as unknown as HTMLInputElement).type = attrs.type;
  if (attrs.placeholder && 'placeholder' in node)
    (node as unknown as HTMLInputElement).placeholder = attrs.placeholder;
  if (attrs.value != null && 'value' in node)
    (node as unknown as HTMLInputElement).value = String(attrs.value);
  if (attrs.min != null) node.setAttribute('min', String(attrs.min));
  if (attrs.max != null) node.setAttribute('max', String(attrs.max));
  if (attrs.step != null) node.setAttribute('step', String(attrs.step));
  if (attrs.checked != null && 'checked' in node)
    (node as unknown as HTMLInputElement).checked = attrs.checked;
  if (attrs.disabled != null && 'disabled' in node)
    (node as unknown as HTMLButtonElement).disabled = attrs.disabled;
  if (attrs.dataset) for (const [k, v] of Object.entries(attrs.dataset)) node.dataset[k] = v;
  if (attrs.on)
    for (const [evt, fn] of Object.entries(attrs.on))
      node.addEventListener(evt, fn as EventListener);
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
