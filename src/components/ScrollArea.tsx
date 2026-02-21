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
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumbHeight, setThumbHeight] = useState(0);
  const [thumbTop, setThumbTop] = useState(0);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartScroll = useRef(0);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      setVisible(false);
      return;
    }
    const ratio = clientHeight / scrollHeight;
    setThumbHeight(Math.max(ratio * clientHeight, 24));
    const trackSpace = clientHeight - Math.max(ratio * clientHeight, 24);
    const scrollRatio = scrollTop / (scrollHeight - clientHeight);
    setThumbTop(scrollRatio * trackSpace);
  }, []);

  // Show thumb briefly, then fade out
  const flash = useCallback(() => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!dragging.current) setVisible(false);
    }, 1200);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { update(); flash(); };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Also observe resize to recalc thumb
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    // Initial calc
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      clearTimeout(hideTimer.current);
    };
  }, [update, flash]);

  // Also observe mutations (children added/removed) to recalc
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mo = new MutationObserver(() => update());
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [update]);

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
      const trackH = el.clientHeight - thumbHeight;
      if (trackH <= 0) return;
      const scrollRange = el.scrollHeight - el.clientHeight;
      el.scrollTop = dragStartScroll.current + (dy / trackH) * scrollRange;
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      hideTimer.current = setTimeout(() => setVisible(false), 800);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [thumbHeight]);

  return (
    <div style={{ position: "relative", overflow: "hidden", ...style }} className={className}>
      <div
        ref={scrollRef}
        style={{
          height: "100%",
          overflowY: "scroll",
          overflowX: "hidden",
          scrollbarWidth: "none",       /* Firefox */
          msOverflowStyle: "none",      /* IE/Edge */
        } as React.CSSProperties}
        className="hide-native-scrollbar"
      >
        {children}
      </div>
      {/* Custom scrollbar track */}
      <div
        ref={trackRef}
        onClick={handleTrackClick}
        onMouseEnter={() => { setVisible(true); setHovered(true); clearTimeout(hideTimer.current); }}
        onMouseLeave={() => { setHovered(false); if (!dragging.current) hideTimer.current = setTimeout(() => setVisible(false), 400); }}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 8,
          height: "100%",
          zIndex: 10,
          cursor: "default",
        }}
      >
        {/* Thumb */}
        <div
          onMouseDown={handleThumbDown}
          style={{
            position: "absolute",
            top: thumbTop,
            right: 1,
            width: 6,
            height: thumbHeight,
            borderRadius: 3,
            background: hovered ? "rgba(255, 255, 255, 0.22)" : "rgba(255, 255, 255, 0.12)",
            opacity: visible ? 1 : 0,
            transition: "opacity 0.25s, background 0.15s",
            cursor: "default",
          }}
        />
      </div>
    </div>
  );
}
