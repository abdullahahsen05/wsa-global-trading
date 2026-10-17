/**
 * Minimal React DOM helpers for component tests (jsdom). No testing library is
 * needed: components are mounted with react-dom and driven with plain DOM events.
 */

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  root: Root;
  rerender: (element: ReactElement) => void;
  unmount: () => void;
}

const mounted: Mounted[] = [];

export function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

/** Mounts an element inside a fresh QueryClientProvider. */
export function mount(element: ReactElement, client: QueryClient = newQueryClient()): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const wrap = (node: ReactElement) => createElement(QueryClientProvider, { client }, node);
  act(() => {
    root.render(wrap(element));
  });
  const handle: Mounted = {
    container,
    root,
    rerender: (next) =>
      act(() => {
        root.render(wrap(next));
      }),
    unmount: () =>
      act(() => {
        root.unmount();
        container.remove();
      }),
  };
  mounted.push(handle);
  return handle;
}

export function unmountAll(): void {
  while (mounted.length > 0) {
    const handle = mounted.pop();
    try {
      handle?.unmount();
    } catch {
      // already unmounted
    }
  }
  document.body.innerHTML = "";
}

/** Lets promises, timers and react-query settle (a few macrotasks). */
export async function settle(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export async function wait(milliseconds: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

export function click(element: Element | null): void {
  if (!element) throw new Error("click: element not found");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function setValue(element: Element | null, value: string): void {
  if (!element) throw new Error("setValue: element not found");
  const isSelect = element instanceof HTMLSelectElement;
  const proto = isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("setValue: no value setter");
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event(isSelect ? "change" : "input", { bubbles: true }));
  });
}

export function submit(form: Element | null): void {
  if (!form) throw new Error("submit: form not found");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

export function keyDown(element: Element | null, key: string): void {
  if (!element) throw new Error("keyDown: element not found");
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

export function text(container: ParentNode): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The first button / link whose visible text contains `label`. */
export function control(container: ParentNode, label: string): HTMLElement | null {
  const wanted = label.toLowerCase();
  const candidates = container.querySelectorAll<HTMLElement>("button, a, [role='tab']");
  for (const candidate of candidates) {
    if ((candidate.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase().includes(wanted)) return candidate;
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
