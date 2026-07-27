import React, { useEffect, useRef, useState } from 'react';

const SPLITTER_WIDTH = 9;
const ABSOLUTE_MIN_PERCENT = 5;
const ABSOLUTE_MAX_PERCENT = 95;

export interface SplitBounds {
  minimum: number;
  maximum: number;
}

export function normalizeSplitPercent(value: number | undefined, fallback: number): number {
  const candidate = value !== undefined && Number.isFinite(value) ? value : fallback;
  return Math.max(ABSOLUTE_MIN_PERCENT, Math.min(ABSOLUTE_MAX_PERCENT, candidate));
}

export function splitBounds(containerWidth: number, minStart: number, minEnd: number): SplitBounds {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { minimum: ABSOLUTE_MIN_PERCENT, maximum: ABSOLUTE_MAX_PERCENT };
  }
  const minimum = Math.max(ABSOLUTE_MIN_PERCENT, Math.min(ABSOLUTE_MAX_PERCENT, minStart / containerWidth * 100));
  const maximum = Math.max(ABSOLUTE_MIN_PERCENT, Math.min(ABSOLUTE_MAX_PERCENT, (containerWidth - SPLITTER_WIDTH - minEnd) / containerWidth * 100));
  if (minimum > maximum) return { minimum: ABSOLUTE_MIN_PERCENT, maximum: ABSOLUTE_MAX_PERCENT };
  return { minimum, maximum };
}

export function clampSplitPercent(value: number, containerWidth: number, minStart: number, minEnd: number): number {
  const bounds = splitBounds(containerWidth, minStart, minEnd);
  return Math.max(bounds.minimum, Math.min(bounds.maximum, normalizeSplitPercent(value, 50)));
}

interface ResizableSplitProps {
  children: React.ReactNode;
  className: string;
  defaultPercent: number;
  initialPercent?: number | undefined;
  minStart: number;
  minEnd: number;
  label: string;
  onChange?: (percent: number) => void;
}

type SplitStyle = React.CSSProperties & {
  '--split-start': string;
  '--split-min-start': string;
  '--split-min-end': string;
};

export function ResizableSplit({
  children,
  className,
  defaultPercent,
  initialPercent,
  minStart,
  minEnd,
  label,
  onChange,
}: ResizableSplitProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const activePointer = useRef<number | undefined>(undefined);
  const percentRef = useRef(normalizeSplitPercent(initialPercent, defaultPercent));
  const [percent, setPercent] = useState(percentRef.current);
  const panes = React.Children.toArray(children);

  if (panes.length !== 2) throw new Error('ResizableSplit requires exactly two panes.');

  const update = (next: number): number => {
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    const clamped = clampSplitPercent(next, width, minStart, minEnd);
    percentRef.current = clamped;
    setPercent(clamped);
    return clamped;
  };

  const updateFromPointer = (clientX: number): number => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return percentRef.current;
    const next = (clientX - bounds.left - SPLITTER_WIDTH / 2) / bounds.width * 100;
    return update(next);
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>, updatePosition = true): void => {
    if (activePointer.current !== event.pointerId) return;
    if (updatePosition) updateFromPointer(event.clientX);
    activePointer.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove('resizing-columns');
    onChange?.(percentRef.current);
  };

  useEffect(() => () => {
    document.body.classList.remove('resizing-columns');
  }, []);

  const style: SplitStyle = {
    '--split-start': `${percent}%`,
    '--split-min-start': `${minStart}px`,
    '--split-min-end': `${minEnd}px`,
  };

  return <div ref={containerRef} className={`resizable-split ${className}`} style={style}>
    {panes[0]}
    <div
      className="splitter"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={Math.round(splitBounds(containerRef.current?.clientWidth ?? 0, minStart, minEnd).minimum)}
      aria-valuemax={Math.round(splitBounds(containerRef.current?.clientWidth ?? 0, minStart, minEnd).maximum)}
      aria-valuenow={Math.round(percent)}
      tabIndex={0}
      title="Drag to resize. Use Left/Right arrows for precise adjustment; double-click to reset."
      onDoubleClick={() => {
        const next = update(defaultPercent);
        onChange?.(next);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 2;
        let next: number | undefined;
        if (event.key === 'ArrowLeft') next = percentRef.current - step;
        else if (event.key === 'ArrowRight') next = percentRef.current + step;
        else if (event.key === 'Home') next = splitBounds(containerRef.current?.clientWidth ?? 0, minStart, minEnd).minimum;
        else if (event.key === 'End') next = splitBounds(containerRef.current?.clientWidth ?? 0, minStart, minEnd).maximum;
        if (next === undefined) return;
        event.preventDefault();
        onChange?.(update(next));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-columns');
      }}
      onPointerMove={(event) => {
        if (activePointer.current === event.pointerId) updateFromPointer(event.clientX);
      }}
      onPointerUp={stopDragging}
      onPointerCancel={(event) => stopDragging(event, false)}
    ><span aria-hidden="true" /></div>
    {panes[1]}
  </div>;
}
