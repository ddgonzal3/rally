import React, { useRef, useState, useEffect, useCallback } from "react";

/**
 * Custom scroll container that hides the native scrollbar and renders
 * a thin, non-expanding thumb indicator on the right edge.
 * Supports click-to-scroll on the track and drag on the thumb.
 */
export function ScrollArea({
  children,
  style,
  className,
  onContextMenu,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartScroll = useRef(0);
  const scrollRaf = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(false);
  // Track thumb dimensions in refs to avoid state updates during scroll
  const thumbState = useRef({ height: 0, top: 0 });

  const updateThumb = useCallback(() => {
    const el = scrollRef.current;
    const thumb = thumbRef.current;
    if (!el || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      thumb.style.opacity = "0";
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const h = Math.max(ratio * clientHeight, 24);
    const trackSpace = clientHeight - h;
    const scrollRatio = scrollTop / (scrollHeight - clientHeight);
    const top = scrollRatio * trackSpace;
    thumbState.current = { height: h, top };
    thumb.style.height = `${h}px`;
    thumb.style.top = `${top}px`;
  }, []);

  const flash = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!dragging.current) setVisible(false);
    }, 500);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    // Scroll handler — update thumb position directly (no state)
    const onScroll = () => {
      if (scrollRaf.current !== null) return;
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = null;
        updateThumb();
        flash();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    // ResizeObserver on the scroll container (viewport size changes)
    const ro = new ResizeObserver(() => updateThumb());
    ro.observe(el);

    // ResizeObserver on the content wrapper (content height changes when
    // folders expand/collapse). Much cheaper than MutationObserver.
    const contentRo = new ResizeObserver(() => updateThumb());
    contentRo.observe(content);

    updateThumb();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollRaf.current !== null) {
        cancelAnimationFrame(scrollRaf.current);
        scrollRaf.current = null;
      }
      ro.disconnect();
      contentRo.disconnect();
      clearTimeout(hideTimer.current);
    };
  }, [updateThumb, flash]);

  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track || e.target !== track) return;
    const rect = track.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = clickY / rect.height;
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
  }, []);

  const handleThumbDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    dragStartY.current = e.clientY;
    dragStartScroll.current = scrollRef.current?.scrollTop ?? 0;
    setVisible(true);
    clearTimeout(hideTimer.current);

    const onMove = (ev: MouseEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const dy = ev.clientY - dragStartY.current;
      const trackH = el.clientHeight - thumbState.current.height;
      if (trackH <= 0) return;
      const scrollRange = el.scrollHeight - el.clientHeight;
      el.scrollTop = dragStartScroll.current + (dy / trackH) * scrollRange;
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      hideTimer.current = setTimeout(() => setVisible(false), 300);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div style={{ position: "relative", overflow: "hidden", ...style }} className={className}>
      <div
        ref={scrollRef}
        style={{
          height: "100%",
          overflowY: "scroll",
          overflowX: "hidden",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        } as React.CSSProperties}
        className="hide-native-scrollbar"
      >
        <div ref={contentRef} onContextMenu={onContextMenu} style={{ minHeight: "100%" }}>
          {children}
        </div>
      </div>
      {/* Custom scrollbar track */}
      <div
        ref={trackRef}
        onClick={handleTrackClick}
        onMouseEnter={() => { setVisible(true); setHovered(true); clearTimeout(hideTimer.current); }}
        onMouseLeave={() => { setHovered(false); if (!dragging.current) hideTimer.current = setTimeout(() => setVisible(false), 200); }}
        style={{
          position: "absolute",
          top: 0,
          right: -1,
          width: 8,
          height: "100%",
          zIndex: 10,
          cursor: "default",
        }}
      >
        {/* Thumb */}
        <div
          ref={thumbRef}
          onMouseDown={handleThumbDown}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 5,
            height: 0,
            borderRadius: 3,
            background: hovered ? "var(--scrollbar-thumb-hover)" : "var(--scrollbar-thumb)",
            opacity: visible ? 1 : 0,
            transition: "opacity 0.25s, background 0.15s",
            cursor: "default",
          }}
        />
      </div>
    </div>
  );
}
