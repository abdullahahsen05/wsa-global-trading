"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tracks the content width (px) of an element so SVG charts can be drawn at
 * their real pixel size instead of being scaled (which would stretch text).
 * Returns 0 until the element has been measured.
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof ResizeObserver === "undefined") {
      const onResize = () => setWidth(element.clientWidth);
      onResize();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    // ResizeObserver reports the initial size right after observe()
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}
